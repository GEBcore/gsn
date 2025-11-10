import { type PrefixedHexString } from 'ethereumjs-util'
import { ethers } from 'ethers'
import { defaultEnvironment, MainnetCalldataGasEstimation, RelayRequest, ForwardRequest, RelayData } from '@opengsn/common'
import relayHubAbi from '@opengsn/common/src/interfaces/IRelayHub.json'

// Use ethers v6 provider type
type EthersV6Provider = ethers.JsonRpcProvider | ethers.BrowserProvider | ethers.FallbackProvider


/**
 * Gas estimation components (matching relayer calculation)
 */
export interface GasComponents {
  /** Estimated msgData.length (character count) */
  msgDataLength: number
  /** Calldata gas used */
  calldataGasUsed: number
  /** Gas and data limits (120000 + 110000) */
  gasAndDataLimits: number
  /** Inner recipient call gas limit */
  innerRecipientCallGasLimit: number
  /** Message data gas cost inside transaction */
  msgDataGasCostInsideTransaction: number
  /** Data on-chain handling gas cost per byte */
  dataOnChainHandlingGasCostPerByte: number
  /** Relay hub gas overhead */
  relayHubGasOverhead: number
}

/**
 * Gas estimation result
 */
export interface GasEstimate {
  /** Gas calculation components */
  components: GasComponents
  /** Maximum possible gas consumption */
  maxPossibleGas: number
  /** Maximum ETH charge in wei */
  maxEthCharge: bigint
  /** Gas price used for calculation */
  gasPrice: bigint
  /** Required ETH amount in human-readable format */
  requiredEth: string
}

/**
 * Conservative gas estimator for GSN transactions
 * Uses relayer's component-based calculation approach
 */
export class ConservativeGasEstimator {
  private readonly BASE_MSGDATA_LENGTH = 2634
  private readonly CALLDATA_MULTIPLIER = 3

  /**
   * Calculate conservative msgData.length based on user calldata
   * Formula: 2634 + calldata_bytes * 3
   *
   * @param userCalldata User's transaction calldata
   * @returns Estimated msgData.length (character count)
   */
  private calculateMsgDataLength(userCalldata: PrefixedHexString): number {
    const calldataBytes = Math.floor(userCalldata.length / 2)
    return this.BASE_MSGDATA_LENGTH + calldataBytes * this.CALLDATA_MULTIPLIER
  }

  /**
   * Create mock relay call ABI input for accurate gas calculation (same as relay server)
   */
  private createRelayCallAbiInput(
    userCalldata: PrefixedHexString,
    targetAddress: string,
    innerRecipientCallGasLimit: number,
    approvalData?: string,
    userAddress?: string,
    paymasterAddress?: string,
    forwarderAddress?: string
  ): any {
    const forwardRequest: ForwardRequest = {
      from: userAddress || '0x1234567890123456789012345678901234567890',
      to: targetAddress,
      data: userCalldata,
      value: '0',
      nonce: '1',
      gas: innerRecipientCallGasLimit.toString(),
      validUntilTime: '1733913600'
    }

    const relayData: RelayData = {
      maxFeePerGas: '50000000',
      maxPriorityFeePerGas: '50000000',
      transactionCalldataGasUsed: '1500000',
      relayWorker: '0x9876543210987654321098765432109876543210',
      paymaster: paymasterAddress || '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      paymasterData: ('0x' + 'f'.repeat(64)),
      clientId: '12345',
      forwarder: forwarderAddress || '0xfedcbafedcbafedcbafedcbafedcbafedcbafed0'
    }

    const relayRequest: RelayRequest = {
      request: forwardRequest,
      relayData: relayData
    }

    return {
      domainSeparatorName: 'GSN Relayed Transaction',
      maxAcceptanceBudget: '0xffffffff',
      relayRequest: relayRequest,
      signature: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678', // Non-zero dummy signature
      approvalData: approvalData || '0x'
    }
  }

  /**
   * Calculate accurate calldataGasUsed using GSN's MainnetCalldataGasEstimation (same as relay server)
   */
  private async calculateCalldataGasUsed(provider: EthersV6Provider, userCalldata: PrefixedHexString, targetAddress: string, innerRecipientCallGasLimit: number, approvalData?: string, userAddress?: string, paymasterAddress?: string, forwarderAddress?: string): Promise<number> {
    // Create the same relay call ABI input that relay server creates with real data
    const relayCallAbiInput = this.createRelayCallAbiInput(userCalldata, targetAddress, innerRecipientCallGasLimit, approvalData, userAddress, paymasterAddress, forwarderAddress)

    // Use ethers to encode the relay call data with real RelayHub ABI
    const iface = new ethers.Interface(relayHubAbi as any[])
    const encodedRelayCall = iface.encodeFunctionData('relayCall', [
      relayCallAbiInput.domainSeparatorName,
      relayCallAbiInput.maxAcceptanceBudget,
      relayCallAbiInput.relayRequest,
      relayCallAbiInput.signature,
      relayCallAbiInput.approvalData
    ]) as PrefixedHexString

    // Use GSN's MainnetCalldataGasEstimation directly (same as relay server)
    return await MainnetCalldataGasEstimation(
      encodedRelayCall,
      defaultEnvironment,
      1, // calldataEstimationSlackFactor
      provider as any
    )
  }

  /**
   * Get gas limit from CLI parameter or fallback to estimation
   *
   * @param provider Ethereum provider
   * @param targetAddress Target contract address
   * @param userCalldata User's transaction calldata
   * @param cliGasLimit Gas limit specified by user via CLI (optional)
   * @returns Gas limit for inner recipient call
   */
  private async getInnerRecipientCallGasLimit(
    provider: EthersV6Provider,
    targetAddress: string,
    userCalldata: PrefixedHexString,
    cliGasLimit?: number
  ): Promise<number> {
    // If user specified gasLimit via CLI, use it directly (matches relay server behavior)
    if (cliGasLimit) {
      console.log(`Using CLI gasLimit: ${cliGasLimit.toLocaleString()}`)
      return cliGasLimit
    }

    // Fallback: estimate gas for the actual contract call
    console.log(`CLI gasLimit not provided, estimating gas for contract call...`)
    const gasEstimate = await provider.estimateGas({
      to: targetAddress,
      data: userCalldata
    })

    // Add safety buffer (30% to be conservative)
    const gasEstimateNumber = Number(gasEstimate.toString())
    const gasWithBuffer = Math.floor(gasEstimateNumber * 1.3)

    // Ensure minimum gas limit for simple calls
    return Math.max(gasWithBuffer, 21000)
  }

  /**
   * Calculate gas components based on relayer calculation method
   */
  private async calculateGasComponents(
    userCalldata: PrefixedHexString,
    targetAddress: string,
    innerRecipientCallGasLimit: number,
    provider: EthersV6Provider,
    approvalData?: string,
    userAddress?: string,
    paymasterAddress?: string,
    forwarderAddress?: string
  ): Promise<GasComponents> {
    // Use GSN's accurate calldata calculation (same as relay server)
    const calldataGasUsed = await this.calculateCalldataGasUsed(provider, userCalldata, targetAddress, innerRecipientCallGasLimit, approvalData, userAddress, paymasterAddress, forwarderAddress)

    // Calculate msgDataLength for msgDataGasCostInsideTransaction
    const msgDataLength = this.calculateMsgDataLength(userCalldata)
    const gasAndDataLimits = 230000 // 120000 + 110000
    const dataOnChainHandlingGasCostPerByte = 13
    const msgDataGasCostInsideTransaction = Math.floor(msgDataLength * dataOnChainHandlingGasCostPerByte)
    const relayHubGasOverhead = 34909

    return {
      msgDataLength,
      calldataGasUsed,
      gasAndDataLimits,
      innerRecipientCallGasLimit,
      msgDataGasCostInsideTransaction,
      dataOnChainHandlingGasCostPerByte,
      relayHubGasOverhead
    }
  }

  /**
   * Calculate maximum possible gas by summing all components and applying GSN safety factors
   *
   * @param components Gas calculation components
   * @returns Maximum possible gas with safety factor and reserve
   */
  private calculateMaxPossibleGas(components: GasComponents): number {
    const GAS_FACTOR = 1.1 // 10% buffer for EIP-150 63/64 rule
    const GAS_RESERVE = 100000 // Fixed gas reserve

    const baseMaxPossibleGas = (
      components.calldataGasUsed +
      components.gasAndDataLimits +
      components.innerRecipientCallGasLimit +
      components.msgDataGasCostInsideTransaction +
      components.relayHubGasOverhead
    )

    // Apply GSN safety factors: (base * GAS_FACTOR) + GAS_RESERVE
    return GAS_RESERVE + Math.floor(baseMaxPossibleGas * GAS_FACTOR)
  }

  /**
   * Get current gas price from provider with 20% markup for safety
   *
   * @param provider Ethereum provider
   * @returns Gas price in wei with safety markup
   */
  private async getSafeGasPrice(provider: EthersV6Provider): Promise<bigint> {
    // Use ethers v6 method to get gas price
    const feeData = await provider.getFeeData()
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas
    if (!gasPrice) {
      throw new Error('Could not get gas price from provider')
    }
    console.log(`Using provider.getFeeData().gasPrice: ${gasPrice}`)

    // Add 20% markup to match relayer behavior
    return BigInt(Math.floor(Number(gasPrice.toString()) * 1.2))
  }

  /**
   * Calculate maximum ETH charge
   *
   * @param maxPossibleGas Maximum possible gas
   * @param gasPrice Gas price in wei
   * @returns Maximum ETH charge in wei
   */
  private calculateMaxEthCharge(maxPossibleGas: number, gasPrice: bigint): bigint {
    return BigInt(maxPossibleGas) * gasPrice
  }

  /**
   * Perform complete gas estimation for a GSN transaction using relayer component method
   *
   * @param userCalldata User's transaction calldata (hex string)
   * @param targetAddress Target contract address for user call
   * @param provider Ethereum provider for gas price and estimation
   * @param cliGasLimit Gas limit specified by user via CLI (optional)
   * @param userAddress User's address (optional)
   * @param paymasterAddress Paymaster address (optional)
   * @param forwarderAddress Forwarder address (optional)
   * @returns Complete gas estimation result
   */
  async estimateGas(
    userCalldata: PrefixedHexString,
    targetAddress: string,
    provider: EthersV6Provider,
    cliGasLimit?: number,
    userAddress?: string,
    paymasterAddress?: string,
    forwarderAddress?: string
  ): Promise<GasEstimate> {
    // Validate calldata format
    if (!userCalldata.startsWith('0x') || userCalldata.length < 2) {
      throw new Error('Invalid calldata format. Must start with "0x"')
    }

    if (userCalldata.length % 2 !== 0) {
      throw new Error('Invalid calldata format. Must have even number of characters')
    }

    // Step 1: Get gas limit from CLI parameter or fallback to estimation
    const innerRecipientCallGasLimit = await this.getInnerRecipientCallGasLimit(
      provider,
      targetAddress,
      userCalldata,
      cliGasLimit
    )

    // Step 2: Calculate gas components using relayer method with GSN accurate calculation
    const components = await this.calculateGasComponents(userCalldata, targetAddress, innerRecipientCallGasLimit, provider, undefined, userAddress, paymasterAddress, forwarderAddress)

    // Step 3: Calculate maximum possible gas by summing components
    const maxPossibleGas = this.calculateMaxPossibleGas(components)

    // Step 4: Get safe gas price with markup
    const gasPrice = await this.getSafeGasPrice(provider)

    // Step 5: Calculate maximum ETH charge
    const maxEthCharge = this.calculateMaxEthCharge(maxPossibleGas, gasPrice)

    // Step 6: Format required ETH amount (simple division)
    const requiredEth = (Number(maxEthCharge.toString()) / 1e18).toFixed(18)

    return {
      components,
      maxPossibleGas,
      maxEthCharge,
      gasPrice,
      requiredEth
    }
  }

  /**
   * Get estimation formula details for debugging/logging
   */
  getFormulaDetails(): {
    baseMsgDataLength: number
    calldataMultiplier: number
  } {
    return {
      baseMsgDataLength: this.BASE_MSGDATA_LENGTH,
      calldataMultiplier: this.CALLDATA_MULTIPLIER
    }
  }
}
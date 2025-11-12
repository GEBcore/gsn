import * as bip39 from 'ethereum-cryptography/bip39'

import Web3 from 'web3'
import commander from 'commander'
import fs from 'fs'
import { hdkey as EthereumHDKey } from 'ethereumjs-wallet'
import { toHex, toWei } from 'web3-utils'
import { ethers } from 'ethers'

import {
  type Address,
  type LoggerInterface
} from '@opengsn/common'

import { type GSNConfig, type GSNUnresolvedConstructorInput } from '@opengsn/provider'
import { createCommandsLogger } from '@opengsn/logger/dist/CommandsWinstonLogger'
import { ConservativeGasEstimator } from '../ConservativeGasEstimator'

import {
  getMnemonic,
  getNetworkUrl,
  gsnCommander,
  getSupportedTokens,
  getTokenInfo,
  getTokenDetails,
  getTokenAllowance,
  generatePermitSignature,
  encodePermitDataWithContractInterface,
  encodePaymasterData,
  getDefaultDeadline,
  displaySupportedTokens
} from '../utils'
// CommandsLogic not used - it requires account access

function commaSeparatedList (value: string, _dummyPrevious: string[]): string[] {
  return value.split(',')
}

/**
 * Generate standalone permit calldata for ERC20 tokens
 */
async function generatePermitCallData (
  tokenAddress: Address,
  spenderAddress: Address,
  amount: string,
  privateKeyHex: string,
  provider: any,
  deadline?: number
): Promise<{
  callData: string,
  owner: Address,
  spender: Address,
  value: string,
  deadline: number,
  tokenAddress: Address,
  v: number,
  r: string,
  s: string
}> {
  if (!privateKeyHex) {
    throw new Error('--privateKeyHex is required for permit generation')
  }

  // Derive owner address from private key
  const owner = new ethers.Wallet(privateKeyHex).address
  console.log(`Owner address: ${owner}`)

  // Convert amount string to appropriate value
  let value: string
  try {
    value = ethers.getBigInt(amount).toString()
    console.log(`Parsed amount as raw value: ${value}`)
  } catch {
    throw new Error(`Invalid amount format: ${amount}. Use number (e.g., "100000000")`)
  }

  // Set deadline
  const finalDeadline = deadline || getDefaultDeadline()
  console.log(`Permit deadline: ${new Date(Number(finalDeadline) * 1000).toLocaleString()}`)

  // Get token decimals for better logging
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ['function decimals() view returns (uint8)'], provider)
    const decimals = await tokenContract.decimals()
    const formattedValue = ethers.formatUnits(value, decimals)
    console.log(`Permit value: ${formattedValue} tokens (${decimals} decimals)`)
  } catch (error) {
    console.log('Could not fetch token decimals, showing raw value')
  }

  // Generate permit signature
  console.log('Generating EIP-712 permit signature...')
  const permitData = await generatePermitSignature(
    tokenAddress,
    owner,
    spenderAddress,
    value,
    finalDeadline.toString(),
    privateKeyHex,
    provider
  )

  // For standalone permit, we'll use the standard permit interface (7 parameters)
  const tokenContract = new ethers.Contract(tokenAddress, [
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external'
  ], provider)

  // Encode the permit call data (standard EIP-2612 format)
  const callData = tokenContract.interface.encodeFunctionData("permit", [
    permitData.owner,
    permitData.spender,
    permitData.value,
    permitData.deadline,
    Number(permitData.v), // Convert bigint to number for uint8
    permitData.r,
    permitData.s
  ])

  console.log('✅ Permit signature generated successfully')
  console.log(`Call data length: ${callData.length} characters (${callData.length / 2 - 1} bytes)`)

  return {
    callData,
    owner: permitData.owner,
    spender: permitData.spender,
    value: permitData.value,
    deadline: Number(permitData.deadline),
    tokenAddress,
    v: Number(permitData.v),
    r: permitData.r,
    s: permitData.s
  }
}

/**
 * Handle token-related operations for GSN transactions
 */
async function handleTokenOperations (
  paymasterAddress: Address,
  userAddress: Address,
  provider: any,
  targetAddress?: Address,
  calldata?: string,
  gasLimit?: number
): Promise<{ tokenAddress: Address, approvalData?: string, gasEstimate?: { maxPossibleGas: number, maxEthCharge: bigint }, tokenDetails?: { name: string, symbol: string, decimals: number, balance: string, nonce: string } }> {
  // If --listTokens is specified, show supported tokens and exit
  if (commander.listTokens) {
    await displaySupportedTokens(paymasterAddress, userAddress, provider)
    process.exit(0)
  }

  let tokenAddress: Address

  // If --token is specified, use that token
  if (commander.token) {
    tokenAddress = commander.token
    console.log(`Using specified token: ${tokenAddress}`)

    // Verify token is supported by paymaster
    const tokenInfo = await getTokenInfo(tokenAddress, paymasterAddress, provider)
    if (!tokenInfo) {
      throw new Error(`Token ${tokenAddress} is not supported by the paymaster`)
    }

    console.log(`✅ Token ${tokenAddress} is supported by paymaster`)
  } else {
    // Auto-discover supported tokens
    console.log('Discovering supported tokens...')
    const supportedTokens = await getSupportedTokens(paymasterAddress, provider)

    if (supportedTokens.length === 0) {
      throw new Error('No supported tokens found for this paymaster')
    }

    if (supportedTokens.length === 1) {
      tokenAddress = supportedTokens[0]
      console.log(`Found one supported token: ${tokenAddress}`)
    } else {
      console.log(`Found ${supportedTokens.length} supported tokens:`)
      for (let i = 0; i < supportedTokens.length; i++) {
        try {
          const tokenDetails = await getTokenDetails(supportedTokens[i], userAddress, provider)
          console.log(`  ${i + 1}. ${tokenDetails.name} (${tokenDetails.symbol}) - ${supportedTokens[i]}`)
        } catch (error) {
          console.log(`  ${i + 1}. ${supportedTokens[i]} (error getting details)`)
        }
      }
      throw new Error('Multiple tokens supported. Please specify --token <address>')
    }
  }

  // Get token details
  const tokenDetails = await getTokenDetails(tokenAddress, userAddress, provider)
  console.log(`Token: ${tokenDetails.name} (${tokenDetails.symbol})`)
  console.log(`Your balance: ${ethers.formatUnits(tokenDetails.balance, tokenDetails.decimals)} ${tokenDetails.symbol}`)
  console.log(`Your nonce: ${tokenDetails.nonce}`)

  // Check allowance
  const allowance = await getTokenAllowance(tokenAddress, userAddress, paymasterAddress, provider)
  console.log(`Current allowance: ${ethers.formatUnits(allowance, tokenDetails.decimals)} ${tokenDetails.symbol}`)

  // Get token info from paymaster
  const tokenInfo = await getTokenInfo(tokenAddress, paymasterAddress, provider)
  if (!tokenInfo) {
    throw new Error(`Token ${tokenAddress} is not supported by the paymaster`)
  }

  // Determine if we need to generate a permit
  let approvalData: string | undefined
  const needPermit = allowance === '0' || commander.forcePermit

  if (needPermit) {
    console.log('Generating EIP-712 permit signature...')

    if (!commander.privateKeyHex) {
      throw new Error('--privateKeyHex is required for permit generation')
    }

    // Set a generous permit value (equivalent to large amount of ETH)
    const permitValue = ethers.MaxUint256.toString() // Maximum possible value

    // Set deadline
    const deadline = commander.permitDeadline || getDefaultDeadline()
    console.log(`Permit deadline: ${new Date(parseInt(deadline) * 1000).toLocaleString()}`)

    // Generate permit signature
    const permitData = await generatePermitSignature(
      tokenAddress,
      userAddress,
      paymasterAddress,
      permitValue,
      deadline,
      commander.privateKeyHex,
      provider
    )

    // Encode the approval data using proper contract interface
    approvalData = encodePermitDataWithContractInterface(
      tokenAddress,
      permitData,
      tokenInfo.permitSelector,
      provider
    )
    console.log('✅ Permit signature generated successfully')
  } else {
    console.log('✅ Sufficient allowance already exists')
  }

  // Perform conservative gas estimation using the new estimator
  console.log('🔮 Performing conservative gas estimation for GSN transaction...')
  try {
    const actualCalldata = calldata || '0x'

    // Initialize the conservative gas estimator
    const gasEstimator = new ConservativeGasEstimator()

    // Use actual target address for gas estimation, fallback to userAddress if not provided
    const estimationTargetAddress = targetAddress || userAddress

    console.log(`Estimation target: ${estimationTargetAddress}`)
    console.log(`Calldata: ${actualCalldata}`)

    // Perform gas estimation with real data and CLI gasLimit
    const gasEstimate = await gasEstimator.estimateGas(
      actualCalldata,
      estimationTargetAddress,
      provider,
      gasLimit,
      userAddress, // real user address from function parameter
      paymasterAddress, // real paymaster address from function parameter
      undefined // forwarder address (will be resolved by GSN)
    )

    console.log(`✅ Conservative gas estimation completed:`)
    console.log(`   User calldata: ${actualCalldata.slice(0, 10)}... (${actualCalldata.length} chars, ${Math.floor(actualCalldata.length / 2)} bytes)`)
    console.log(`\n📊 Gas Components Breakdown:`)
    console.log(`   msgDataLength: ${gasEstimate.components.msgDataLength.toLocaleString()}`)
    console.log(`   calldataGasUsed: ${gasEstimate.components.calldataGasUsed.toLocaleString()}`)
    console.log(`   gasAndDataLimits: ${gasEstimate.components.gasAndDataLimits.toLocaleString()}`)
    console.log(`   innerRecipientCallGasLimit: ${gasEstimate.components.innerRecipientCallGasLimit.toLocaleString()}`)
    console.log(`   msgDataGasCostInsideTransaction: ${gasEstimate.components.msgDataGasCostInsideTransaction.toLocaleString()}`)
    console.log(`   dataOnChainHandlingGasCostPerByte: ${gasEstimate.components.dataOnChainHandlingGasCostPerByte}`)
    console.log(`   relayHubGasOverhead: ${gasEstimate.components.relayHubGasOverhead.toLocaleString()}`)
    console.log(`\n💰 Total Calculation:`)
    console.log(`   Maximum possible gas: ${gasEstimate.maxPossibleGas.toLocaleString()}`)
    console.log(`   Gas price (with 20% markup): ${(Number(gasEstimate.gasPrice.toString()) / 1e9).toFixed(6)} gwei`)
    console.log(`   Estimated max ETH charge: ${gasEstimate.maxEthCharge.toString()} wei`)
    console.log(`   Required: ${gasEstimate.requiredEth} ETH`)

    // Calculate and display max token charge if we have token info
    try {
      const tokenInfo = await getTokenInfo(tokenAddress, paymasterAddress, provider)
      if (tokenInfo && tokenDetails) {
        // Calculate token charge: (maxEthCharge * tokenExchangeRate) / 1e18
        const tokenExchangeRate = BigInt(tokenInfo.exchangeRate)
        const maxTokenCharge = (gasEstimate.maxEthCharge * tokenExchangeRate) / BigInt(10 ** 18)
        const maxTokenChargeFormatted = ethers.formatUnits(maxTokenCharge.toString(), tokenDetails.decimals)

        console.log(`   Required: ${maxTokenChargeFormatted} ${tokenDetails.symbol})`)
      }
    } catch (tokenError: any) {
      console.log(`   Token charge calculation failed: ${tokenError.message}`)
    }

    return {
      tokenAddress,
      approvalData,
      gasEstimate: {
        maxPossibleGas: gasEstimate.maxPossibleGas,
        maxEthCharge: gasEstimate.maxEthCharge
      },
      tokenDetails
    }
  } catch (error: any) {
    console.warn('⚠️  Conservative gas estimation failed, proceeding without pre-estimation:', error.message)
    // Continue without gas estimation - fallback to runtime calculation
    return {
      tokenAddress,
      approvalData
    }
  }
}

// A provider that extends ethers.JsonRpcProvider but bypasses getSigner() calls
class NoSignerProvider extends ethers.JsonRpcProvider {
  constructor(url: string) {
    super(url)
  }

  getSigner(address?: string) {
    return undefined as any
  }
}

gsnCommander(['n', 'f', 'm', 'g', 'l'])
  .option('--directCall', 'whether to run transaction with relay or directly', false)
  .option('--abiFile <string>', 'path to an ABI truffle artifact JSON file')
  .option('--method <string>', 'method name to execute')
  .option('--methodParams <items>', 'comma separated args list', commaSeparatedList)
  .option('--calldata <string>', 'exact calldata to use')
  .option('--to <string>', 'target RelayRecipient contract')
  .option('--paymaster <string>', 'the Paymaster contract to be used')
  .option('--token <string>', 'ERC20 token address for gas payment (for token-based paymasters)')
  .option('--listTokens', 'list all supported tokens by the paymaster')
  .option('--permitDeadline <number>', 'Permit deadline (seconds since epoch, default: 1 hour from now)')
  .option('--forcePermit', 'force permit generation even with sufficient allowance')
  // Permit-only options
  .option('--permit-erc20 <string>', 'Generate permit calldata for specified ERC20 token address')
  .option('--spender <string>', 'Spender address for permit (required with --permit-erc20)')
  .option('--amount <string>', 'Amount to approve for permit (required with --permit-erc20, can be number or "max")')
  .parse(process.argv)

async function getProvider (
  to: Address | undefined,
  paymaster: Address,
  mnemonic: string | undefined,
  logger: LoggerInterface,
  host: string,
  targetCalldata?: string
): Promise<{ provider: any, from: Address, tokenData?: { tokenAddress: Address, approvalData?: string, paymasterData: string, gasEstimate?: { maxPossibleGas: number, maxEthCharge: bigint } } }> {
  let from: Address
  if (commander.privateKeyHex != null) {
    // For GSN transactions, derive from privateKeyHex to ensure consistency
    const wallet = new ethers.Wallet(commander.privateKeyHex)
    from = wallet.address
    console.log('using address from privateKeyHex:', from)

    // Validate that --from (if provided) matches the private key
    if (commander.from != null && commander.from.toLowerCase() !== from.toLowerCase()) {
      throw new Error(`Address mismatch: --from ${commander.from} does not match address derived from --privateKeyHex ${from}`)
    }
  } else if (commander.from != null) {
    // provider-controlled private key
    from = commander.from
    console.log('using', from)
  } else if (mnemonic != null) {
    const hdwallet = EthereumHDKey.fromMasterSeed(
      Buffer.from(bip39.mnemonicToSeedSync(mnemonic))
    )
    // add mnemonic private key to the account manager as an 'ephemeral key'
    const wallet = hdwallet.deriveChild(0).getWallet()
    from = `0x${wallet.getAddress().toString('hex')}`
    console.log('mnemonic account:', from)
  } else {
    throw new Error('must specify either "--mnemonic", "--from" or "--privateKeyHex"')
  }

  if (commander.directCall === true) {
    // Direct call: use wallet with NoSignerProvider
    const wallet = new ethers.Wallet(commander.privateKeyHex, new NoSignerProvider(host))
    return { provider: wallet, from }
  } else {
    if (paymaster == null) {
      throw new Error('--paymaster: address not specified')
    }

    if (commander.privateKeyHex == null) {
      throw new Error('--privateKeyHex is required for GSN transactions')
    }

    // GSN call: use wallet with NoSignerProvider
    const { RelayProvider } = await import('@opengsn/provider')

    // Create a temporary provider for token operations
    const tempProvider = new ethers.JsonRpcProvider(host)
    let tokenData: { tokenAddress: Address, approvalData?: string, paymasterData: string, gasEstimate?: { maxPossibleGas: number, maxEthCharge: bigint } } | undefined

    // Handle token operations for GebPermitERC20Paymaster
    console.log('Starting token operations for paymaster:', paymaster)
    try {
      const gas = commander.gasLimit ? parseInt(commander.gasLimit) : undefined
      const tokenOps = await handleTokenOperations(paymaster, from, tempProvider, to, targetCalldata, gas)
      tokenData = {
        tokenAddress: tokenOps.tokenAddress,
        approvalData: tokenOps.approvalData,
        paymasterData: encodePaymasterData(tokenOps.tokenAddress),
        gasEstimate: tokenOps.gasEstimate
      }
      console.log(`✅ Token operations successful:`)
      console.log(`   Token: ${tokenOps.tokenAddress}`)
      console.log(`   PaymasterData: ${tokenData.paymasterData}`)
      console.log(`   ApprovalData: ${tokenOps.approvalData ? 'Present' : 'Not required'}`)
      if (tokenOps.gasEstimate) {
        console.log(`   Pre-calculated gas estimate: ${tokenOps.gasEstimate.maxPossibleGas.toLocaleString()}`)
      }
      if (tokenOps.gasEstimate && tokenOps.tokenDetails) {
        // Calculate token charge based on token exchange rate
        const tokenInfo = await getTokenInfo(tokenOps.tokenAddress, paymaster, tempProvider)
        if (tokenInfo) {
          // Calculate token charge: (maxEthCharge * tokenExchangeRate) / 1e18
          const tokenExchangeRate = BigInt(tokenInfo.exchangeRate)
          const maxTokenCharge = (tokenOps.gasEstimate.maxEthCharge * tokenExchangeRate) / BigInt(10 ** 18)
          console.log(`   Required: ${ethers.formatUnits(maxTokenCharge.toString(), tokenOps.tokenDetails.decimals)} ${tokenOps.tokenDetails.symbol}`)
        }
      }
    } catch (error: any) {
      // If token operations fail, we might be using a different paymaster
      console.error('❌ Token operations failed, proceeding with regular GSN transaction:')
      console.error('Error:', error?.message || String(error))
      console.error('Stack:', error?.stack || 'No stack available')
      console.error('Paymaster address:', paymaster)
      console.error('From address:', from)
      console.error('Provider URL:', host)
    }

    const config: Partial<GSNConfig> = {
      clientId: '0',
      paymasterAddress: paymaster,
      performDryRunViewRelayCall: false,
      maxPaymasterDataLength: 32, // Allow 32 bytes for token address
      maxApprovalDataLength: 228 // EIP-2612 permit signature data
    }

    const wallet = new ethers.Wallet(commander.privateKeyHex, new NoSignerProvider(host))

    const input: GSNUnresolvedConstructorInput = {
      provider: wallet,  // Pass wallet directly - GSN will detect it's a signer
      config,
      overrideDependencies: {
        asyncPaymasterData: async (relayRequest: any) => {
          if (tokenData) {
            console.log(`📝 Providing paymasterData: ${tokenData.paymasterData}`)
            return tokenData.paymasterData
          }
          return '0x'
        },
        asyncApprovalData: async (relayRequest: any, relayRequestId: string): Promise<string> => {
          if (!tokenData) {
            return '0x'
          }

          // Use pre-calculated approvalData from handleTokenOperations
          // This avoids expensive gas calculation during transaction processing
          if (tokenData.approvalData) {
            console.log(`📝 Using pre-calculated approvalData: ${tokenData.approvalData.slice(0, 10)}...`)
            if (tokenData.gasEstimate) {
              console.log(`   Using pre-calculated gas estimate: ${tokenData.gasEstimate.maxPossibleGas.toLocaleString()}`)
            }
            return tokenData.approvalData
          } else {
            console.log(`✅ No approvalData needed (sufficient allowance pre-checked)`)
            if (tokenData.gasEstimate) {
              console.log(`   Using pre-calculated gas estimate: ${tokenData.gasEstimate.maxPossibleGas.toLocaleString()}`)
            }
            return '0x'
          }
        }
      }
    }

    const relayProvider = await RelayProvider.newWeb3Provider(input)

    return {
      provider: relayProvider,
      from,
      tokenData
    }
  }
}

(async () => {
  // Handle permit-only mode
  if (commander.permitErc20) {
    console.log('🔐 Generating standalone ERC20 permit calldata...')

    // Validate required parameters for permit-only mode
    if (!commander.spender) {
      throw new Error('--spender is required when using --permit-erc20')
    }
    if (!commander.amount) {
      throw new Error('--amount is required when using --permit-erc20')
    }
    if (!commander.privateKeyHex) {
      throw new Error('--privateKeyHex is required when using --permit-erc20')
    }

    const network: string = commander.network
    const nodeURL = getNetworkUrl(network)
    const provider = new ethers.JsonRpcProvider(nodeURL)

    try {
      const permitResult = await generatePermitCallData(
        commander.permitErc20,
        commander.spender,
        commander.amount,
        commander.privateKeyHex,
        provider,
        commander.permitDeadline ? parseInt(commander.permitDeadline) : undefined
      )

      console.log('\n📋 Permit Calldata Generated:')
      console.log('=' .repeat(50))
      console.log(`Token Address: ${permitResult.tokenAddress}`)
      console.log(`Owner Address: ${permitResult.owner}`)
      console.log(`Spender Address: ${permitResult.spender}`)
      console.log(`Value: ${permitResult.value}`)
      console.log(`Deadline: ${permitResult.deadline} (${new Date(permitResult.deadline * 1000).toLocaleString()})`)
      console.log(`v: ${permitResult.v}`)
      console.log(`r: ${permitResult.r}`)
      console.log(`s: ${permitResult.s}`)

      console.log('\n📤 Call Data:')
      console.log(permitResult.callData)

      process.exit(0)
    } catch (error: any) {
      console.error('❌ Permit generation failed:', error.message)
      console.error('Stack:', error.stack || 'No stack available')
      process.exit(1)
    }
  }

  // Original GSN transaction mode
  const network: string = commander.network
  const nodeURL = getNetworkUrl(network)
  const logger = createCommandsLogger(commander.loglevel)
  const mnemonic = getMnemonic(commander.mnemonic)

  if (commander.from == null && commander.privateKeyHex == null && mnemonic == null) {
    throw new Error('must specify either "--from", "--privateKeyHex" or "--mnemonic"')
  }

  const providerResult = await getProvider(
    commander.to,
    commander.paymaster,
    mnemonic,
    logger,
    nodeURL,
    commander.calldata
  )
  const { provider, from } = providerResult

  // ABI is only needed for method calls, not for direct calldata
  let abiJson: any = null

  if (commander.method != null) {
    if (commander.abiFile == null || !fs.existsSync(commander.abiFile)) {
      const file: string = commander.abiFile
      throw new Error(`--abiFile: ABI file ${file} does not exist`)
    }
    abiJson = JSON.parse(fs.readFileSync(commander.abiFile, 'utf8'))
  }
  if (commander.to == null) {
    throw new Error('--to: target address is missing')
  }

  // Create contract - only needed for method calls
  let web3Contract: any = null

  if (commander.method != null && abiJson != null) {
    if (commander.directCall === true && provider.sendTransaction) {
      // Direct call with ethers Wallet - use ethers contract
      const { Contract } = await import('@ethersproject/contracts')
      web3Contract = new Contract(commander.to, abiJson, provider)
    } else {
      // GSN provider or Web3 provider
      const web3 = new Web3(provider)
      web3Contract = new web3.eth.Contract(abiJson, commander.to)
    }
  }

  const calldata = commander.calldata
  const methodName: string = commander.method
  if (calldata != null && methodName != null) {
    throw new Error('Cannot pass both --calldata and --method')
  }
  if (calldata == null && methodName == null) {
    throw new Error('Must pass either --calldata or --method')
  }

  if (calldata != null) {
    // Use calldata directly
    const gas = commander.gasLimit ? parseInt(commander.gasLimit) : undefined
    let gasPrice

    if (commander.directCall === true && provider.sendTransaction) {
      // Direct call with ethers Wallet
      gasPrice = commander.gasPrice != null ? toWei(commander.gasPrice, 'gwei').toString() : await provider.getGasPrice()

      const receipt = await provider.sendTransaction({
        to: commander.to,
        data: calldata,
        gasLimit: gas,
        gasPrice
      })
      console.log(receipt)
    } else {
      // GSN provider or Web3 provider
      const web3 = new Web3(provider)
      gasPrice = commander.gasPrice != null ? toWei(commander.gasPrice, 'gwei').toString() : await web3.eth.getGasPrice()

      // Transaction parameters (GSN will handle paymasterData and approvalData via callbacks)
      const txParams: any = {
        from,
        to: commander.to,
        data: calldata,
        gas,
        gasPrice: toHex(gasPrice)
      }

      console.log('🚀 Sending GSN transaction (token data will be added via callbacks)...')
      const receipt = await web3.eth.sendTransaction(txParams)
      console.log(receipt)
    }
  } else {
    // Use method name
    if (commander.directCall === true && provider.sendTransaction) {
      // Direct call with ethers contract
      const method = (web3Contract as any)[methodName]
      if (method == null) {
        throw new Error(`Method (${methodName}) is not found on contract`)
      }
      const methodParams = commander.methodParams

      const gasPrice = commander.gasPrice != null ? toWei(commander.gasPrice, 'gwei').toString() : await provider.getGasPrice()
      const gas = commander.gasLimit

      const receipt = await method(...methodParams, {
        gasLimit: gas,
        gasPrice
      })
      console.log(receipt)
    } else {
      // GSN provider or Web3 provider
      const method = web3Contract.methods[methodName]
      if (method == null) {
        throw new Error(`Method (${methodName}) is not found on contract`)
      }
      const methodParams = commander.methodParams

      const web3 = new Web3(provider)
      const gasPrice = toHex(commander.gasPrice != null ? toWei(commander.gasPrice, 'gwei').toString() : await web3.eth.getGasPrice())
      const gas = commander.gasLimit

      // Transaction parameters (GSN will handle paymasterData and approvalData via callbacks)
      const txParams: any = {
        from,
        gas,
        gasPrice
      }

      console.log('🚀 Sending GSN transaction (token data will be added via callbacks)...')
      const receipt = await method(...methodParams).send(txParams)
      console.log(receipt)
    }
  }

  console.log(JSON.stringify(commander.methodParams))
  console.log('Contract address:', commander.to)
  process.exit(0)
})().catch(
  reason => {
    console.error(reason)
    process.exit(1)
  }
)

import * as bip39 from 'ethereum-cryptography/bip39'

import Web3 from 'web3'
import commander from 'commander'
import fs from 'fs'
import { type PrefixedHexString } from 'ethereumjs-util'
import { hdkey as EthereumHDKey } from 'ethereumjs-wallet'
import { toHex, toWei } from 'web3-utils'
import { type HttpProvider } from 'web3-core'
import { ethers } from 'ethers'

import {
  type Address,
  constants,
  type LoggerInterface
} from '@opengsn/common'

import { type GSNConfig, type GSNDependencies, type GSNUnresolvedConstructorInput, RelayProvider } from '@opengsn/provider'
import { createCommandsLogger } from '@opengsn/logger/dist/CommandsWinstonLogger'

import {
  getMnemonic,
  getNetworkUrl,
  gsnCommander,
  type TokenInfo,
  getSupportedTokens,
  getTokenInfo,
  getTokenDetails,
  getTokenAllowance,
  generatePermitSignature,
  encodePermitData,
  encodePaymasterData,
  getDefaultDeadline,
  displaySupportedTokens
} from '../utils'
// CommandsLogic not used - it requires account access

function commaSeparatedList (value: string, _dummyPrevious: string[]): string[] {
  return value.split(',')
}

/**
 * Handle token-related operations for GSN transactions
 */
async function handleTokenOperations (
  paymasterAddress: Address,
  userAddress: Address,
  provider: any
): Promise<{ tokenAddress: Address, approvalData?: string }> {
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
    const permitValue = ethers.parseUnits('1000', 18).toString() // 1000 ETH equivalent

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

    // Encode the approval data
    approvalData = encodePermitData(permitData, tokenInfo.permitSelector)
    console.log('✅ Permit signature generated successfully')
  } else {
    console.log('✅ Sufficient allowance already exists')
  }

  return {
    tokenAddress,
    approvalData
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
  .parse(process.argv)

async function getProvider (
  to: Address,
  paymaster: Address,
  mnemonic: string | undefined,
  logger: LoggerInterface,
  host: string
): Promise<{ provider: any, from: Address, tokenData?: { tokenAddress: Address, approvalData?: string, paymasterData: string } }> {
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
    let tokenData: { tokenAddress: Address, approvalData?: string, paymasterData: string } | undefined

    // Handle token operations for GebPermitERC20Paymaster
    console.log('Starting token operations for paymaster:', paymaster)
    try {
      const tokenOps = await handleTokenOperations(paymaster, from, tempProvider)
      tokenData = {
        tokenAddress: tokenOps.tokenAddress,
        approvalData: tokenOps.approvalData,
        paymasterData: encodePaymasterData(tokenOps.tokenAddress)
      }
      console.log(`✅ Token operations successful:`)
      console.log(`   Token: ${tokenOps.tokenAddress}`)
      console.log(`   PaymasterData: ${tokenData.paymasterData}`)
      console.log(`   ApprovalData: ${tokenOps.approvalData ? 'Present' : 'Not required'}`)
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
      maxApprovalDataLength: 300 // Allow space for 260-byte permit signature data
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

          // Check if we still need to provide approvalData by checking current allowance
          try {
            const tokenAddress = tokenData.tokenAddress
            const allowance = await getTokenAllowance(tokenAddress, from, paymaster, tempProvider)

            // Estimate the gas cost (rough estimate)
            const gasEstimate = parseInt(relayRequest.request.gas || '100000')
            const gasPrice = relayRequest.relayData.maxFeePerGas || '0x927c0'
            const maxEthCharge = BigInt(gasEstimate) * BigInt(gasPrice)

            // Get token info to calculate token cost
            const tokenInfo = await getTokenInfo(tokenAddress, paymaster, tempProvider)
            if (tokenInfo) {
              const maxTokenCharge = (maxEthCharge * BigInt(tokenInfo.exchangeRate)) / BigInt('1000000000000000000')

              console.log(`🔍 Checking allowance:`)
              console.log(`   Current allowance: ${ethers.formatUnits(allowance, 18)}`)
              console.log(`   Required: ${ethers.formatUnits(maxTokenCharge.toString(), 18)}`)

              if (BigInt(allowance) >= maxTokenCharge) {
                console.log(`✅ Sufficient allowance, no approvalData needed`)
                return '0x'
              } else {
                console.log(`❌ Insufficient allowance, providing approvalData`)
                if (tokenData.approvalData) {
                  console.log(`📝 Providing approvalData: ${tokenData.approvalData.slice(0, 10)}...`)
                  return tokenData.approvalData
                }
              }
            }
          } catch (error) {
            console.warn('Error checking allowance, providing approvalData anyway:', error)
          }

          // Fallback: provide approvalData if we can't determine allowance
          if (tokenData.approvalData) {
            console.log(`📝 Providing approvalData (fallback): ${tokenData.approvalData.slice(0, 10)}...`)
            return tokenData.approvalData
          }
          return '0x'
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
    nodeURL
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

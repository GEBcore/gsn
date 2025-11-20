// TODO: allow reading network URLs from 'truffle-config.js'
import commander, { type CommanderStatic } from 'commander'
import fs from 'fs'
import path from 'path'
import { ethers } from 'ethers'

import { type Address, type RelayHubConfiguration, type GSNContractsDeployment, type LoggerInterface } from '@opengsn/common'

import { type ServerConfigParams } from '@opengsn/relay/dist/ServerConfigParams'

const cliInfuraId = '$INFURA_ID'
export const networks = new Map<string, string>([
  ['localhost', 'http://127.0.0.1:8545'],
  ['xdai', 'https://dai.poa.network'],
  ['arbitrum_rinkeby', 'https://rinkeby.arbitrum.io/rpc'],
  ['optimism_kovan', 'https://kovan.optimism.io/'],
  ['ropsten', 'https://ropsten.infura.io/v3/' + cliInfuraId],
  ['rinkeby', 'https://rinkeby.infura.io/v3/' + cliInfuraId],
  ['kovan', 'https://kovan.infura.io/v3/' + cliInfuraId],
  ['goerli', 'https://goerli.infura.io/v3/' + cliInfuraId],
  ['mainnet', 'https://mainnet.infura.io/v3/' + cliInfuraId]
])

export const networksBlockExplorers = new Map<string, string>([
  ['xdai', 'https://blockscout.com/poa/xdai/'],
  ['arbitrum_rinkeby', 'https://rinkeby-explorer.arbitrum.io/#/'],
  ['optimism_kovan', 'https://kovan-optimistic.etherscan.io/'],
  ['ropsten', 'https://ropsten.etherscan.io/'],
  ['rinkeby', 'https://rinkeby.etherscan.io/'],
  ['kovan', 'https://kovan.etherscan.io/'],
  ['goerli', 'https://goerli.etherscan.io/'],
  ['mainnet', 'https://etherscan.io/']
])

export function supportedNetworks (): string[] {
  return Array.from(networks.keys())
}

export function getNetworkUrl (network: string, env: Record<string, string | undefined> = process.env): string {
  const net = networks.get(network)
  if (net == null) {
    const match = network.match(/^(https?:\/\/.*)/) ?? []
    const firstMatch = match[0]
    if (firstMatch == null) {
      throw new Error(`network ${network} is not supported`)
    }
    return firstMatch
  }

  if (net.includes('$INFURA_ID')) {
    const str = env.INFURA_ID ?? ''
    if (str === '') { throw new Error(`network ${network}: INFURA_ID not set`) }
    return net.replace(/\$INFURA_ID/, str)
  }

  return net
}

export function getMnemonic (mnemonicFile: string): string | undefined {
  if (mnemonicFile == null || mnemonicFile === '') {
    return
  }
  console.log('Using mnemonic from file ' + mnemonicFile)
  return fs.readFileSync(mnemonicFile, { encoding: 'utf8' }).replace(/\r?\n|\r/g, '')
}

export function getKeystorePath (keystorePath: string): string {
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`keystorePath ${keystorePath} not found`)
  }
  if (fs.lstatSync(keystorePath).isDirectory() && fs.existsSync(keystorePath + '/keystore')) {
    return keystorePath
  } else if (fs.lstatSync(keystorePath).isFile() && path.basename(keystorePath) === 'keystore') {
    return path.dirname(keystorePath)
  }
  throw new Error(`keystorePath ${keystorePath} not a file or directory`)
}

export function getServerConfig (configFilename: string): ServerConfigParams {
  if (!fs.existsSync(configFilename) || !fs.lstatSync(configFilename).isFile()) {
    throw new Error(`configFilename ${configFilename} must be a file`)
  }
  return JSON.parse(fs.readFileSync(configFilename, 'utf8'))
}

export function getRelayHubConfiguration (configFile: string): RelayHubConfiguration | undefined {
  if (configFile == null) {
    return
  }
  console.log('Using hub config from file ' + configFile)
  const file = fs.readFileSync(configFile, { encoding: 'utf8' })
  return JSON.parse(file)
}

export function getPaymasterAddress (paymaster?: string): string | undefined {
  return getAddressFromFile('build/gsn/Paymaster.json', paymaster)
}

export function getRelayHubAddress (defaultAddress?: string): string | undefined {
  return getAddressFromFile('build/gsn/RelayHub.json', defaultAddress)
}

function getAddressFromFile (path: string, defaultAddress?: string): string | undefined {
  if (defaultAddress == null) {
    if (fs.existsSync(path)) {
      const relayHubDeployInfo = fs.readFileSync(path).toString()
      return JSON.parse(relayHubDeployInfo).address
    }
  }
  return defaultAddress
}

function saveContractToFile (address: Address | undefined, workdir: string, filename: string): void {
  if (address == null) {
    throw new Error('Address is not initialized!')
  }
  fs.mkdirSync(workdir, { recursive: true })
  fs.writeFileSync(path.join(workdir, filename), `{ "address": "${address}" }`)
}

export function saveDeployment (deploymentResult: GSNContractsDeployment, workdir: string): void {
  saveContractToFile(deploymentResult.stakeManagerAddress, workdir, 'StakeManager.json')
  saveContractToFile(deploymentResult.penalizerAddress, workdir, 'Penalizer.json')
  saveContractToFile(deploymentResult.relayHubAddress, workdir, 'RelayHub.json')
  saveContractToFile(deploymentResult.paymasterAddress, workdir, 'Paymaster.json')
  saveContractToFile(deploymentResult.forwarderAddress, workdir, 'Forwarder.json')
  saveContractToFile(deploymentResult.relayRegistrarAddress, workdir, 'RelayRegistrar.json')
  saveContractToFile(deploymentResult.managerStakeTokenAddress, workdir, 'ManagerStakeTokenAddress.json')
}

export function showDeployment (
  deploymentResult: GSNContractsDeployment,
  title: string | undefined,
  logger: LoggerInterface,
  paymasterTitle: string | undefined = undefined
): void {
  if (title != null) {
    logger.error(title)
  }
  logger.error(`
  RelayHub: ${deploymentResult.relayHubAddress}
  RelayRegistrar: ${deploymentResult.relayRegistrarAddress}
  StakeManager: ${deploymentResult.stakeManagerAddress}
  Penalizer: ${deploymentResult.penalizerAddress}
  Forwarder: ${deploymentResult.forwarderAddress}
  TestToken (test only): ${deploymentResult.managerStakeTokenAddress}
  Paymaster ${paymasterTitle != null ? '(' + paymasterTitle + ')' : ''}: ${deploymentResult.paymasterAddress}`)
}

export function loadDeployment (workdir: string): GSNContractsDeployment {
  function getAddress (name: string): string {
    return getAddressFromFile(path.join(workdir, name + '.json')) as string
  }

  return {
    relayHubAddress: getAddress('RelayHub'),
    relayRegistrarAddress: getAddress('RelayRegistrar'),
    stakeManagerAddress: getAddress('StakeManager'),
    managerStakeTokenAddress: getAddress('ManagerStakeTokenAddress'),
    penalizerAddress: getAddress('Penalizer'),
    forwarderAddress: getAddress('Forwarder'),
    paymasterAddress: getAddress('Paymaster')
  }
}

type GsnOption = 'n' | 'f' | 'h' | 'm' | 'g' | 'l'

export function gsnCommander (options: GsnOption[]): CommanderStatic {
  options.forEach(option => {
    switch (option) {
      case 'n':
        commander.option('-n, --network <url|name>', 'network name or URL to an Ethereum node', 'localhost')
        break
      case 'f':
        commander.option('-f, --from <address>', 'account to send transactions from (default: the first account with balance)')
        break
      case 'h':
        commander.option('-h, --hub <address>', 'address of the hub contract (default: the address from build/gsn/RelayHub.json if exists)')
        break
      case 'm':
        commander.option('-m, --mnemonic <mnemonic>', 'mnemonic file to generate private key for account \'from\'')
        commander.option('--derivationPath <string>', 'derivation path for the mnemonic to use, defaults to m/44\'/60\'/0\'/0/')
        commander.option('--derivationIndex <string>', 'derivation index to use with a given mnemonic, defaults to 0', '0')
        commander.option('--privateKeyHex <string>', 'private key to use directly without mnemonic')
        break
      case 'g':
        commander.option('-g, --gasPrice <number>', 'gas price to give to the transaction, in gwei.')
        break
      case 'l':
        commander.option('-l, --gasLimit <number>', 'gas limit to give to all transactions', '5000000')
        break
    }
  })
  commander.option('--loglevel <string>', 'silent | error | warn | info | debug', 'debug')
  return commander
}

// Token-related interfaces and functions for GebPermitERC20Paymaster support

export interface TokenInfo {
  address: Address
  exchangeRate: string
  permitSelector: string
  validFromBlock: string
  enabled: boolean
}

export interface PermitData {
  owner: Address
  spender: Address
  value: string
  nonce: string
  deadline: string
  v: number
  r: string
  s: string
}

/**
 * Get all supported tokens from a GebPermitERC20Paymaster contract
 */
export async function getSupportedTokens (
  paymasterAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<Address[]> {
  // GebPermitERC20Paymaster ABI - only the functions we need
  const paymasterAbi = [
    'function getSupportedTokens() external view returns (address[])',
    'function getTokenInfo(address token) external view returns (tuple(uint256 exchangeRate, bytes4 permitSelector, uint256 validFromBlock, bool enabled))'
  ]

  const paymasterContract = new ethers.Contract(paymasterAddress, paymasterAbi, provider)
  return await paymasterContract.getSupportedTokens()
}

/**
 * Get detailed information about a specific token from the paymaster
 */
export async function getTokenInfo (
  tokenAddress: Address,
  paymasterAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<TokenInfo | null> {
  const paymasterAbi = [
    'function getTokenInfo(address token) external view returns (tuple(uint256 exchangeRate, bytes4 permitSelector, uint256 validFromBlock, bool enabled))'
  ]

  try {
    const paymasterContract = new ethers.Contract(paymasterAddress, paymasterAbi, provider)
    const tokenInfo = await paymasterContract.getTokenInfo(tokenAddress)

    if (!tokenInfo.enabled) {
      return null
    }

    return {
      address: tokenAddress,
      exchangeRate: tokenInfo.exchangeRate.toString(),
      permitSelector: tokenInfo.permitSelector,
      validFromBlock: tokenInfo.validFromBlock.toString(),
      enabled: tokenInfo.enabled
    }
  } catch (error) {
    console.error(`Error getting token info for ${tokenAddress}:`, error)
    return null
  }
}

/**
 * Get all supported tokens with their detailed information
 */
export async function getAllTokenInfo (
  paymasterAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<TokenInfo[]> {
  const supportedTokens = await getSupportedTokens(paymasterAddress, provider)
  const tokenInfos: TokenInfo[] = []

  for (const tokenAddress of supportedTokens) {
    const tokenInfo = await getTokenInfo(tokenAddress, paymasterAddress, provider)
    if (tokenInfo) {
      tokenInfos.push(tokenInfo)
    }
  }

  return tokenInfos
}

/**
 * Get ERC20 token details (name, symbol, decimals, balance, nonce)
 */
export async function getTokenDetails (
  tokenAddress: Address,
  userAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<{ name: string, symbol: string, decimals: number, balance: string, nonce: string }> {
  const tokenAbi = [
    'function name() external view returns (string)',
    'function symbol() external view returns (string)',
    'function decimals() external view returns (uint8)',
    'function balanceOf(address account) external view returns (uint256)',
    'function nonces(address owner) external view returns (uint256)'
  ]

  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider)

  const [name, symbol, decimals, balance, nonce] = await Promise.all([
    tokenContract.name(),
    tokenContract.symbol(),
    tokenContract.decimals(),
    tokenContract.balanceOf(userAddress),
    tokenContract.nonces(userAddress)
  ])

  return {
    name,
    symbol,
    decimals,
    balance: balance.toString(),
    nonce: nonce.toString()
  }
}

/**
 * Check token allowance for the paymaster
 */
export async function getTokenAllowance (
  tokenAddress: Address,
  ownerAddress: Address,
  spenderAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<string> {
  const tokenAbi = [
    'function allowance(address owner, address spender) external view returns (uint256)'
  ]

  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider)
  const allowance = await tokenContract.allowance(ownerAddress, spenderAddress)
  return allowance.toString()
}

/**
 * Get current nonce for permit from token contract
 */
export async function getTokenNonce (
  tokenAddress: Address,
  ownerAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<string> {
  const tokenAbi = [
    'function nonces(address owner) external view returns (uint256)'
  ]

  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider)
  const nonce = await tokenContract.nonces(ownerAddress)
  return nonce.toString()
}

/**
 * Generate EIP-712 permit signature for ERC20 tokens
 */
export async function generatePermitSignature (
  tokenAddress: Address,
  ownerAddress: Address,
  spenderAddress: Address,
  value: string,
  deadline: string,
  privateKey: string,
  provider: ethers.JsonRpcProvider
): Promise<PermitData> {
  const wallet = new ethers.Wallet(privateKey, provider)

  // Get EIP-712 domain data from token contract
  // Get DOMAIN_SEPARATOR directly from token contract
  const domainSeparator = await getEIP712DomainSeparator(tokenAddress, provider)

  // Get current nonce from token contract (important for EIP-2612)
  const nonce = await getTokenNonce(tokenAddress, ownerAddress, provider)

  // Use correct EIP-2612 Permit TypeHash with nonce
  const permitTypeHash = ethers.keccak256(ethers.toUtf8Bytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'))
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [permitTypeHash, ownerAddress, spenderAddress, value, nonce, deadline]
    )
  )

  const digest = ethers.keccak256(
    ethers.solidityPacked(
      ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
      ['0x19', '0x01', domainSeparator, structHash]
    )
  )

  // Sign the digest using EIP-712 method (direct digest signing, not EIP-191 message signing)
  const signingKey = new ethers.SigningKey(privateKey)
  const signature = signingKey.sign(digest)
  const { v, r, s } = signature

  // Ethers SigningKey returns v as 27 or 28 (standard EIP-712 format)
  // No conversion needed, just ensure it's a number
  // @ts-ignore - TypeScript doesn't know v type
  const vNormalized = Number(v)

  return {
    owner: ownerAddress,
    spender: spenderAddress,
    value,
    nonce,
    deadline,
    v: vNormalized,
    r,
    s
  }
}

/**
 * Get EIP-712 domain data from token contract
 */
async function getEIP712DomainSeparator (
  tokenAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<string> {
  // Directly get DOMAIN_SEPARATOR from token contract
  const tokenAbi = [
    'function DOMAIN_SEPARATOR() external view returns (bytes32)'
  ];
  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);

  try {
    const domainSeparator = await tokenContract.DOMAIN_SEPARATOR();
    return domainSeparator;
  } catch (error) {
    throw new Error(`Token contract at ${tokenAddress} does not support DOMAIN_SEPARATOR() function. Please use a token contract that implements EIP-712.`);
  }
}


/**
 * Encode paymasterData (token address)
 * GebPermitERC20Paymaster expects exactly 32 bytes containing the token address
 */
export function encodePermitDataWithContractInterface (
  tokenAddress: Address,
  permitData: PermitData,
  permitSelector: string,
  provider: any
): string {
  // Create a contract interface for proper ABI encoding (7-parameter permit)
  const tokenContract = new ethers.Contract(tokenAddress, [
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external'
  ], provider)

  // Use contract interface to encode the permit call data (7 parameters, no nonce)
  const callData = tokenContract.interface.encodeFunctionData("permit", [
    permitData.owner,
    permitData.spender,
    permitData.value,
    permitData.deadline,
    Number(permitData.v), // Convert bigint to number for uint8
    permitData.r,
    permitData.s
  ])

  console.log(`🔧 Contract interface encoded approvalData: ${callData.length} characters (${callData.length / 2 - 1} bytes)`)

  // Verify length: should be 4 bytes selector + 7*32 bytes parameters = 228 bytes
  const expectedLength = 4 + 7 * 32
  const actualLength = callData.length / 2 - 1

  if (actualLength !== expectedLength) {
    throw new Error(`Invalid approvalData length: ${actualLength} bytes, expected ${expectedLength} bytes`)
  }

  return callData
}

export function encodePaymasterData (tokenAddress: Address): string {
  // Remove 0x prefix if present
  const cleanAddress = tokenAddress.replace('0x', '')
  // Pad to 64 characters (32 bytes) and prepend with 0x
  return '0x' + cleanAddress.padStart(64, '0')
}

/**
 * Calculate default deadline (1 hour from now)
 */
export function getDefaultDeadline (): string {
  return Math.floor(Date.now() / 1000 + 3600).toString()
}

/**
 * Display supported tokens with user information
 */
export async function displaySupportedTokens (
  paymasterAddress: Address,
  userAddress: Address,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  console.log('Fetching supported tokens from paymaster...')

  const tokenInfos = await getAllTokenInfo(paymasterAddress, provider)

  if (tokenInfos.length === 0) {
    console.log('No supported tokens found for this paymaster.')
    return
  }

  console.log('\nSupported Tokens:')
  console.log('==================')

  for (let i = 0; i < tokenInfos.length; i++) {
    const tokenInfo = tokenInfos[i]
    console.log(`\n${i + 1}. ${tokenInfo.address}`)

    try {
      const tokenDetails = await getTokenDetails(tokenInfo.address, userAddress, provider)
      const allowance = await getTokenAllowance(tokenInfo.address, userAddress, paymasterAddress, provider)

      console.log(`   Name: ${tokenDetails.name} (${tokenDetails.symbol})`)
      console.log(`   Decimals: ${tokenDetails.decimals}`)
      console.log(`   Your Balance: ${ethers.formatUnits(tokenDetails.balance, tokenDetails.decimals)} ${tokenDetails.symbol}`)
      console.log(`   Your Nonce: ${tokenDetails.nonce}`)
      console.log(`   Allowance: ${ethers.formatUnits(allowance, tokenDetails.decimals)} ${tokenDetails.symbol}`)
      console.log(`   Exchange Rate: 1 ETH = ${ethers.formatUnits(tokenInfo.exchangeRate, 18)} ${tokenDetails.symbol}`)
      console.log(`   Valid From Block: ${tokenInfo.validFromBlock}`)
      console.log(`   Permit Selector: ${tokenInfo.permitSelector}`)
    } catch (error) {
      console.log(`   Error getting token details: ${error}`)
    }
  }
}

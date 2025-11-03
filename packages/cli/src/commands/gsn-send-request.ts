import * as bip39 from 'ethereum-cryptography/bip39'

import Web3 from 'web3'
import commander from 'commander'
import fs from 'fs'
import { type PrefixedHexString } from 'ethereumjs-util'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { hdkey as EthereumHDKey } from 'ethereumjs-wallet'
import { toHex, toWei } from 'web3-utils'
import { type HttpProvider } from 'web3-core'

import {
  type Address,
  constants,
  type LoggerInterface
} from '@opengsn/common'
import { Wallet } from '@ethersproject/wallet'
import { JsonRpcProvider } from '@ethersproject/providers'

import { type GSNConfig, type GSNDependencies, type GSNUnresolvedConstructorInput, RelayProvider } from '@opengsn/provider'
import { createCommandsLogger } from '@opengsn/logger/dist/CommandsWinstonLogger'

import { getMnemonic, getNetworkUrl, gsnCommander } from '../utils'
// CommandsLogic not used - it requires account access

function commaSeparatedList (value: string, _dummyPrevious: string[]): string[] {
  return value.split(',')
}

// A provider that extends JsonRpcProvider but bypasses getSigner() calls
class NoSignerProvider extends JsonRpcProvider {
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
  .parse(process.argv)

async function getProvider (
  to: Address,
  paymaster: Address,
  mnemonic: string | undefined,
  logger: LoggerInterface,
  host: string): Promise<{ provider: any, from: Address }> {
  let from: Address
  if (commander.from != null) {
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
    throw new Error('must specify either "--mnemonic" or pass "--from" account')
  }

  if (commander.directCall === true) {
    // Direct call: use wallet with NoSignerProvider
    const wallet = new Wallet(commander.privateKeyHex, new NoSignerProvider(host))
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

    const config: Partial<GSNConfig> = {
      clientId: '0',
      paymasterAddress: paymaster
    }

    const wallet = new Wallet(commander.privateKeyHex, new NoSignerProvider(host))

    const input: GSNUnresolvedConstructorInput = {
      provider: wallet,  // Pass wallet directly - GSN will detect it's a signer
      config
    }

    const relayProvider = await RelayProvider.newWeb3Provider(input)

    return {
      provider: relayProvider,
      from
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

  const { provider, from } = await getProvider(
    commander.to,
    commander.paymaster,
    mnemonic,
    logger,
    nodeURL
  )

  if (commander.abiFile == null || !fs.existsSync(commander.abiFile)) {
    const file: string = commander.abiFile
    throw new Error(`--abiFile: ABI file ${file} does not exist`)
  }
  const abiJson = JSON.parse(fs.readFileSync(commander.abiFile, 'utf8'))
  if (commander.to == null) {
    throw new Error('--to: target address is missing')
  }

  // Create contract - handle both Web3 provider and ethers Wallet
  let web3Contract
  if (commander.directCall === true && provider.sendTransaction) {
    // Direct call with ethers Wallet - use ethers contract
    const { Contract } = await import('@ethersproject/contracts')
    web3Contract = new Contract(commander.to, abiJson, provider)
  } else {
    // GSN provider or Web3 provider
    const web3 = new Web3(provider)
    web3Contract = new web3.eth.Contract(abiJson, commander.to)
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
    const gas = commander.gasLimit
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

      const receipt = await web3.eth.sendTransaction({
        from,
        to: commander.to,
        data: calldata,
        gas,
        gasPrice: toHex(gasPrice)
      })
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

      const receipt = await method(...methodParams).send({
        from,
        gas,
        gasPrice
      })
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

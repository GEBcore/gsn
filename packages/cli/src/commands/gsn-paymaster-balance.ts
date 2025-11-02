import { ContractInteractor, constants, defaultEnvironment } from '@opengsn/common'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { getNetworkUrl, getPaymasterAddress, getRelayHubAddress, gsnCommander } from '../utils'
import { createCommandsLogger } from '@opengsn/logger/dist/CommandsWinstonLogger'

const commander = gsnCommander(['h', 'n'])
  .option('--paymaster <address>', 'address of the paymaster contract')
  .parse(process.argv);

(async () => {
  const network: string = commander.network
  const nodeURL = getNetworkUrl(network)

  const hub = getRelayHubAddress(commander.hub)
  const paymaster = getPaymasterAddress(commander.paymaster)

  if (hub == null || paymaster == null) {
    throw new Error(`Contracts not found: hub: ${hub} paymaster: ${paymaster} `)
  }
  const logger = createCommandsLogger(commander.loglevel)

  // Use VoidSigner for read-only operations (same pattern as in runServer)
  const { VoidSigner } = await import('@ethersproject/abstract-signer')
  const ethersJsonRpcProvider = new StaticJsonRpcProvider(nodeURL)
  const voidSigner = new VoidSigner(constants.ZERO_ADDRESS, ethersJsonRpcProvider)

  const contractInteractor = new ContractInteractor({
    provider: ethersJsonRpcProvider,
    signer: voidSigner,
    logger,
    environment: defaultEnvironment,
    deployment: { relayHubAddress: hub },
    maxPageSize: Number.MAX_SAFE_INTEGER
  })

  await contractInteractor.init()
  const balance = await contractInteractor.hubBalanceOf(paymaster)

  // Format balance from wei to ether
  const balanceInEther = parseFloat(balance.toString()) / 1e18
  console.log(`Account ${paymaster} has a GSN balance of ${balanceInEther.toFixed(6)} ETH`)
})().catch(
  reason => {
    console.error(reason)
    process.exit(1)
  }
)

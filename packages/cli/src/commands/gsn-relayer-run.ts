#!/usr/bin/env node

import commander from 'commander'
import { supportedNetworks } from '../utils'

// Enhanced help and description for the relayer run command
const program = commander.program

program
  .name('gsn relayer-run')
  .description('Launch a GSN (Gas Station Network) Relay Server that enables gasless transactions for dApps')
  .option('--config <path>', 'Path to JSON configuration file containing all relay settings')
  .option('--workdir <path>', 'Working directory for relay data storage (default: ./relay-workdir)')
  .option('--port <number>', 'Port number for the relay HTTP server (default: 8090)')
  .option('--devMode', '[WARNING] Development mode: clears all storage on startup. Use with caution!')
  .option('--logLevel <level>', 'Logging level: error, warn, info, debug (default: info)')
  .option('--relayHubAddress <addr>', 'Address of the RelayHub contract on the network')
  .option('--managerStakeTokenAddress <addr>', 'Address of the token used for staking')
  .option('--ownerAddress <addr>', 'Address of the relay owner (for withdrawals)')
  .option('--url <url>', 'Public URL of the relay server (provided to dApps)')
  .option('--gasPriceFactor <num>', 'Multiplier for gas price calculations (default: 1)')
  .option('--checkInterval <ms>', 'Block polling interval in milliseconds (default: 15000)')
  .option('--workerMinBalance <eth>', 'Minimum ETH balance for worker account (default: 0.001)')
  .option('--workerTargetBalance <eth>', 'Target ETH balance for worker account (default: 0.005)')
  .option('--managerMinBalance <eth>', 'Minimum ETH balance for manager account (default: 0.001)')
  .option('--managerTargetBalance <eth>', 'Target ETH balance for manager account (default: 0.005)')
  .option('--withdrawToOwnerOnBalance <eth>', 'Withdraw excess balance to owner (default: 0.02)')
  .option('--managerMinStake <tokens>', 'Minimum stake required for manager (default: 1)')
  .option('--ethereumNodeUrl <url>', 'Ethereum node URL (overrides --network)')
  .on('--help', () => {
    console.log(`
Examples:
  # Run with configuration file (recommended)
  gsn relayer-run --config ./relay-config.json

  # Run with minimal configuration using custom node
  gsn relayer-run \\
    --relayHubAddress 0x456... \\
    --ethereumNodeUrl https://custom-node.example.com \\
    --ownerAddress 0xabc... \\
    --port 8091

  # Run with custom node URL and debug logging
  gsn relayer-run \\
    --config ./relay-config.json \\
    --ethereumNodeUrl https://custom-node.example.com \\
    --logLevel debug

  # Run on mainnet with default port
  gsn relayer-run \\
    --config ./relay-config.json \\
    --ethereumNodeUrl https://mainnet.infura.io/v3/YOUR_ID

Configuration File Format:
  A JSON file with the following key fields:
  {
    "relayHubAddress": "0x...",
    "managerStakeTokenAddress": "0x...",
    "ownerAddress": "0x...",
    "ethereumNodeUrl": "https://...",
    "workerMinBalance": "0.001",
    "workerTargetBalance": "0.005",
    "managerMinBalance": "0.001",
    "managerTargetBalance": "0.005",
    "withdrawToOwnerOnBalance": "0.02",
    "port": 8090,
    "workdir": "./relay-workdir"
  }

Balance Fields:
  All balance fields (workerMinBalance, workerTargetBalance, etc.)
  should be specified in ETH units as decimal strings.
  Examples: "0.001", "0.005", "0.02"

Network Connection:
  Use --ethereumNodeUrl to connect to any Ethereum network.
  Examples: https://mainnet.infura.io/v3/YOUR_ID, https://your-node.com
`)
  })
  .parse(process.argv)

// If no arguments provided, show examples
if (process.argv.length <= 2) {
  console.log(`
Usage: gsn relayer-run [options]

Launch a GSN Relay Server

Quick Start:
  1. Create a configuration file 'relay-config.json'
  2. Run: gsn relayer-run --config ./relay-config.json

Example Configuration:
{
  "relayHubAddress": "0x45b3636d8c1DC97680F76a0BaB7Edb14E23c9948",
  "managerStakeTokenAddress": "0x83F3Dc9e6287265820A3cF10aEa8D70d2c061eFf",
  "ownerAddress": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "ethereumNodeUrl": "https://ethereum-rpc.publicnode.com",
  "workerMinBalance": "0.001",
  "workerTargetBalance": "0.005",
  "managerMinBalance": "0.001",
  "managerTargetBalance": "0.005",
  "withdrawToOwnerOnBalance": "0.02",
  "port": 8080,
  "workdir": "./relay-workdir",
  "devMode": true
}

Run 'gsn relayer-run --help' for complete options and examples
`)
  process.exit(0)
}

// Import and run the server
require('@opengsn/relay/dist/runServer')

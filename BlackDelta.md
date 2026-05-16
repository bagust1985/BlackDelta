# BlackDelta — Product Requirements Document (PRD)

## Product Name

# BlackDelta

> BlackDelta is an autonomous AI-powered liquidity intelligence system for Solana.

---

# Overview

BlackDelta is the evolution of the original Meridian repository into a modular, multi-DEX, AI-native liquidity operating system designed for autonomous capital allocation and liquidity management across the Solana ecosystem.

The system combines:
- AI-driven strategy execution
- Real-time market intelligence
- Advanced risk analysis
- Multi-DEX liquidity orchestration
- Autonomous treasury operations
- Smart wallet intelligence

BlackDelta aims to become a fully autonomous liquidity intelligence infrastructure layer for Solana DeFi.

---

# Vision

## Long-Term Vision

BlackDelta becomes:

> “The autonomous liquidity intelligence layer for Solana.”

A system capable of:
- discovering opportunities
- analyzing risk
- deploying liquidity
- reallocating capital
- adapting strategies
- learning from outcomes

without continuous human intervention.

---

# Core Objectives

## Primary Goals

1. Transform the current Meteora-only architecture into a multi-DEX framework
2. Build a modular AI-native liquidity management system
3. Improve risk-adjusted returns
4. Reduce rug/exploit exposure
5. Enable real-time autonomous execution
6. Introduce intelligent treasury allocation
7. Support future multi-agent orchestration

---

# Non-Goals (V2)

The following are outside the scope of V2:

- Cross-chain execution
- On-chain smart contracts
- Custodial infrastructure
- Centralized exchange integrations
- High-frequency trading
- Mobile applications

---

# Current State (Legacy Meridian)

Current repository capabilities:
- Meteora DLMM LP management
- AI-driven screening
- AI-driven LP management
- Telegram integration
- Decision logs
- Pool memory
- Basic risk filtering
- Cron-based execution
- Dry-run support

Current limitations:
- Meteora-only execution
- Single-agent architecture
- No DEX abstraction layer
- Polling-only system
- Limited analytics
- No semantic memory
- Weak strategy modularity
- No backtesting framework

---

# Product Philosophy

BlackDelta is designed around:

## 1. Modular Intelligence

Every intelligence layer should be replaceable and extensible.

## 2. Autonomous Operations

The system should minimize manual intervention.

## 3. Safety First

Capital preservation is prioritized over aggressive deployment.

## 4. Real-Time Awareness

The system must react to market conditions immediately.

## 5. Explainable Decisions

Every deployment and exit decision must be traceable and auditable.

---

# System Architecture

# High-Level Architecture

```txt id="bd-arch"
                   +----------------------+
                   |    User / Operator   |
                   +----------------------+
                              |
                              v
                   +----------------------+
                   | Telegram / CLI / UI  |
                   +----------------------+
                              |
                              v
                   +----------------------+
                   |   BlackDelta Core    |
                   +----------------------+
                    /        |         \
                   /         |          \
                  v          v           v
        +---------------+ +--------+ +-------------+
        | Risk Engine   | | Memory | | Signal Hub |
        +---------------+ +--------+ +-------------+
                   \         |         /
                    \        |        /
                             v
                  +----------------------+
                  |  Strategy Engine     |
                  +----------------------+
                              |
                              v
                  +----------------------+
                  |  Execution Layer     |
                  +----------------------+
                   /         |         \
                  /          |          \
                 v           v           v
         +-----------+ +-----------+ +-----------+
         | Meteora   | | Raydium  | | Orca      |
         +-----------+ +-----------+ +-----------+
                              |
                              v
                  +----------------------+
                  | Solana RPC/WebSocket |
                  +----------------------+

/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/stonkfolio_distributor.json`.
 */
export type StonkfolioDistributor = {
  "address": "C4mQLDEnnFupVCwQbr9Bzygr9kJaowRTmmUEb9FoFaLh",
  "metadata": {
    "name": "stonkfolioDistributor",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "abandonRound",
      "docs": [
        "Keeper abandons a round that never got a seed (before close, or after the seed aged out)."
      ],
      "discriminator": [
        38,
        71,
        227,
        16,
        69,
        115,
        171,
        164
      ],
      "accounts": [
        {
          "name": "rootAuthority",
          "signer": true
        },
        {
          "name": "distributor",
          "writable": true
        },
        {
          "name": "intent",
          "writable": true
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "acceptRootAuthority",
      "docs": [
        "Proposed keeper key accepts, completing the handoff."
      ],
      "discriminator": [
        108,
        147,
        163,
        175,
        67,
        148,
        250,
        100
      ],
      "accounts": [
        {
          "name": "newRootAuthority",
          "signer": true
        },
        {
          "name": "distributor",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "activateAsset",
      "docs": [
        "Permissionless: marks an asset payable once its vault covers the allocation."
      ],
      "discriminator": [
        157,
        189,
        77,
        194,
        202,
        69,
        103,
        52
      ],
      "accounts": [
        {
          "name": "round"
        },
        {
          "name": "roundAsset",
          "writable": true
        },
        {
          "name": "vault"
        }
      ],
      "args": []
    },
    {
      "name": "closeAsset",
      "docs": [
        "Permissionless after expiry: returns everything left to the keeper for",
        "the next round and closes the asset's accounts."
      ],
      "discriminator": [
        39,
        124,
        90,
        146,
        16,
        82,
        77,
        253
      ],
      "accounts": [
        {
          "name": "distributor"
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "roundAsset",
          "writable": true
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "rolloverDestination",
          "writable": true
        },
        {
          "name": "rolloverWallet",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "closeWindow",
      "docs": [
        "Keeper closes the window; the program records the snapshot chain head and Pyth SOL/USD."
      ],
      "discriminator": [
        254,
        46,
        169,
        88,
        40,
        214,
        216,
        17
      ],
      "accounts": [
        {
          "name": "rootAuthority",
          "signer": true
        },
        {
          "name": "distributor"
        },
        {
          "name": "intent",
          "writable": true
        },
        {
          "name": "priceUpdate"
        }
      ],
      "args": [
        {
          "name": "snapshotChainHead",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "snapshotCount",
          "type": "u32"
        }
      ]
    },
    {
      "name": "commitRound",
      "docs": [
        "Keeper reveals the secret and commits the round's asset tree."
      ],
      "discriminator": [
        229,
        102,
        157,
        34,
        152,
        217,
        15,
        70
      ],
      "accounts": [
        {
          "name": "rootAuthority",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "distributor",
          "writable": true
        },
        {
          "name": "intent",
          "writable": true
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "distributor"
              },
              {
                "kind": "arg",
                "path": "params.round_id"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "commitRoundParams"
            }
          }
        }
      ]
    },
    {
      "name": "createDistributor",
      "docs": [
        "Permissionless: creates a distributor for an index coin under the signer's key, fixing its round policy."
      ],
      "discriminator": [
        184,
        103,
        26,
        71,
        141,
        64,
        49,
        177
      ],
      "accounts": [
        {
          "name": "rootAuthority",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "indexMint"
        },
        {
          "name": "distributor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  116,
                  114,
                  105,
                  98,
                  117,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "indexMint"
              },
              {
                "kind": "account",
                "path": "rootAuthority"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "createDistributorParams"
            }
          }
        }
      ]
    },
    {
      "name": "openAsset",
      "docs": [
        "Permissionless: proves one asset tuple against the round's root,",
        "vets the mint, and creates the asset's vault."
      ],
      "discriminator": [
        223,
        137,
        134,
        228,
        160,
        92,
        175,
        254
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "roundAsset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  95,
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "arg",
                "path": "params.asset_idx"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "openAssetParams"
            }
          }
        }
      ]
    },
    {
      "name": "openRound",
      "docs": [
        "Keeper commits sha256(secret) for the next round before taking snapshots."
      ],
      "discriminator": [
        66,
        235,
        123,
        240,
        8,
        35,
        185,
        159
      ],
      "accounts": [
        {
          "name": "rootAuthority",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "distributor"
        },
        {
          "name": "intent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "distributor"
              },
              {
                "kind": "arg",
                "path": "roundId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roundId",
          "type": "u64"
        },
        {
          "name": "secretCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "proposeRootAuthority",
      "docs": [
        "Current keeper key proposes its replacement."
      ],
      "discriminator": [
        152,
        72,
        30,
        214,
        86,
        219,
        60,
        222
      ],
      "accounts": [
        {
          "name": "rootAuthority",
          "signer": true
        },
        {
          "name": "distributor",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newRootAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "pushPayout",
      "docs": [
        "Permissionless push to the recipient's canonical ATA. The recipient",
        "does not sign; the destination is pinned to them."
      ],
      "discriminator": [
        181,
        131,
        32,
        136,
        81,
        147,
        126,
        2
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone may pay for a push; amounts and destinations are fixed by the root."
          ],
          "signer": true
        },
        {
          "name": "round"
        },
        {
          "name": "roundAsset",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "recipient"
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "leafIdx",
          "type": "u32"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "pushPayouts",
      "docs": [
        "Permissionless batched push: pays the `Push` leaves of one aligned block",
        "(up to 32 leaves) with a single proof, each into its recipient's",
        "canonical ATA. Leaves already paid are skipped."
      ],
      "discriminator": [
        63,
        244,
        190,
        23,
        249,
        76,
        241,
        251
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone may pay for pushes; amounts and destinations are fixed by the root."
          ],
          "signer": true
        },
        {
          "name": "round"
        },
        {
          "name": "roundAsset",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "pushPayoutsParams"
            }
          }
        }
      ]
    },
    {
      "name": "recordSeed",
      "docs": [
        "Permissionless: records the seed block hash once it exists."
      ],
      "discriminator": [
        191,
        138,
        109,
        128,
        184,
        187,
        146,
        134
      ],
      "accounts": [
        {
          "name": "distributor"
        },
        {
          "name": "intent",
          "writable": true
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "selfClaim",
      "docs": [
        "Recipient-signed claim into any token account the recipient owns —",
        "the fallback when a push can't land (memo-required, frozen, etc.)."
      ],
      "discriminator": [
        250,
        46,
        65,
        135,
        224,
        250,
        13,
        216
      ],
      "accounts": [
        {
          "name": "round"
        },
        {
          "name": "roundAsset",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "recipient",
          "signer": true
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "leafIdx",
          "type": "u32"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "sweepExcess",
      "docs": [
        "Permissionless: returns vault balance above what is still owed to the",
        "keeper, which rolls it into the next round."
      ],
      "discriminator": [
        255,
        74,
        219,
        182,
        1,
        126,
        233,
        6
      ],
      "accounts": [
        {
          "name": "distributor"
        },
        {
          "name": "roundAsset"
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "rolloverDestination",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "distributor",
      "discriminator": [
        90,
        90,
        217,
        147,
        6,
        32,
        135,
        4
      ]
    },
    {
      "name": "roundAsset",
      "discriminator": [
        109,
        62,
        139,
        114,
        27,
        215,
        112,
        226
      ]
    },
    {
      "name": "roundHeader",
      "discriminator": [
        124,
        254,
        213,
        187,
        92,
        98,
        185,
        182
      ]
    },
    {
      "name": "roundIntent",
      "discriminator": [
        250,
        212,
        132,
        180,
        46,
        188,
        54,
        121
      ]
    }
  ],
  "events": [
    {
      "name": "assetActivated",
      "discriminator": [
        211,
        181,
        232,
        88,
        59,
        234,
        236,
        12
      ]
    },
    {
      "name": "assetClosed",
      "discriminator": [
        188,
        16,
        158,
        249,
        202,
        223,
        33,
        216
      ]
    },
    {
      "name": "assetOpened",
      "discriminator": [
        214,
        17,
        201,
        134,
        246,
        128,
        99,
        198
      ]
    },
    {
      "name": "distributorCreated",
      "discriminator": [
        46,
        236,
        214,
        20,
        159,
        117,
        177,
        233
      ]
    },
    {
      "name": "excessSwept",
      "discriminator": [
        231,
        176,
        175,
        65,
        146,
        2,
        209,
        157
      ]
    },
    {
      "name": "payoutEvent",
      "discriminator": [
        84,
        234,
        195,
        72,
        143,
        79,
        70,
        82
      ]
    },
    {
      "name": "rootAuthorityRotated",
      "discriminator": [
        45,
        188,
        81,
        157,
        31,
        106,
        151,
        77
      ]
    },
    {
      "name": "roundAbandoned",
      "discriminator": [
        244,
        100,
        135,
        140,
        189,
        183,
        198,
        3
      ]
    },
    {
      "name": "roundCommitted",
      "discriminator": [
        42,
        214,
        109,
        128,
        88,
        18,
        110,
        67
      ]
    },
    {
      "name": "roundOpened",
      "discriminator": [
        99,
        173,
        228,
        72,
        142,
        57,
        109,
        178
      ]
    },
    {
      "name": "seedRecorded",
      "discriminator": [
        176,
        114,
        72,
        12,
        81,
        180,
        228,
        197
      ]
    },
    {
      "name": "windowClosed",
      "discriminator": [
        121,
        79,
        118,
        86,
        121,
        66,
        96,
        11
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized for this instruction"
    },
    {
      "code": 6001,
      "name": "invalidConfig",
      "msg": "Invalid config value"
    },
    {
      "code": 6002,
      "name": "noPendingRootAuthority",
      "msg": "No pending root authority, or signer is not the pending root authority"
    },
    {
      "code": 6003,
      "name": "invalidRoundId",
      "msg": "round_id must equal distributor.next_round_id"
    },
    {
      "code": 6004,
      "name": "invalidAssetCount",
      "msg": "asset_count must be at most MAX_ASSETS_PER_ROUND"
    },
    {
      "code": 6005,
      "name": "expiryTooSoon",
      "msg": "expiry_ts is earlier than now + min_expiry_secs"
    },
    {
      "code": 6006,
      "name": "invalidAllowMask",
      "msg": "allow_freeze_authority_mask names an asset index >= asset_count"
    },
    {
      "code": 6007,
      "name": "roundMismatch",
      "msg": "Round account does not match this asset"
    },
    {
      "code": 6008,
      "name": "distributorMismatch",
      "msg": "Distributor account does not match this asset"
    },
    {
      "code": 6009,
      "name": "intentMismatch",
      "msg": "Round intent does not belong to this distributor and round"
    },
    {
      "code": 6010,
      "name": "invalidIntentStatus",
      "msg": "Round intent is not in the required status"
    },
    {
      "code": 6011,
      "name": "windowTooShort",
      "msg": "Round window has not been open for the minimum duration"
    },
    {
      "code": 6012,
      "name": "emptyWindow",
      "msg": "A window must include at least one snapshot"
    },
    {
      "code": 6013,
      "name": "secretMismatch",
      "msg": "Revealed secret does not match the round's commitment"
    },
    {
      "code": 6014,
      "name": "seedNotYetAvailable",
      "msg": "The seed block is not available yet"
    },
    {
      "code": 6015,
      "name": "seedExpired",
      "msg": "The seed block is no longer in SlotHashes; the round can only be abandoned"
    },
    {
      "code": 6016,
      "name": "cannotAbandon",
      "msg": "A round can only be abandoned while open, a day after its window closed if its seed expired unrecorded, or seven days after seeding"
    },
    {
      "code": 6017,
      "name": "invalidPriceAccount",
      "msg": "Price account is not a Pyth PriceUpdateV2 account"
    },
    {
      "code": 6018,
      "name": "priceFeedMismatch",
      "msg": "Price account or feed does not match the distributor's price feed"
    },
    {
      "code": 6019,
      "name": "priceNotFullyVerified",
      "msg": "Price update is not fully verified"
    },
    {
      "code": 6020,
      "name": "priceTooOld",
      "msg": "Price update is too old"
    },
    {
      "code": 6021,
      "name": "priceConfidenceTooWide",
      "msg": "Price confidence interval is too wide"
    },
    {
      "code": 6022,
      "name": "invalidPrice",
      "msg": "Price must be positive"
    },
    {
      "code": 6023,
      "name": "assetIndexOutOfRange",
      "msg": "asset_idx is out of range for this round"
    },
    {
      "code": 6024,
      "name": "assetAlreadyOpened",
      "msg": "This asset index was already opened for this round"
    },
    {
      "code": 6025,
      "name": "invalidLeafCount",
      "msg": "leaf_count must be between 1 and MAX_LEAVES_PER_ASSET"
    },
    {
      "code": 6026,
      "name": "invalidAllocation",
      "msg": "allocated must be greater than zero"
    },
    {
      "code": 6027,
      "name": "invalidAssetProof",
      "msg": "Asset tuple is not in the round's assets_root"
    },
    {
      "code": 6028,
      "name": "proofTooLong",
      "msg": "Proof exceeds MAX_PROOF_LEN"
    },
    {
      "code": 6029,
      "name": "invalidTokenProgram",
      "msg": "Token program must be spl-token or spl-token-2022 and own the mint"
    },
    {
      "code": 6030,
      "name": "invalidAccountData",
      "msg": "Account data is not a valid token mint or token account"
    },
    {
      "code": 6031,
      "name": "mintNotInitialized",
      "msg": "Mint is not initialized"
    },
    {
      "code": 6032,
      "name": "mintExtensionNotAllowed",
      "msg": "Mint carries a Token-2022 extension the distributor does not allow"
    },
    {
      "code": 6033,
      "name": "mintHasFreezeAuthority",
      "msg": "Mint has a freeze authority and this asset was not allow-listed for one"
    },
    {
      "code": 6034,
      "name": "mintHasTransferHook",
      "msg": "Mint has a transfer hook program or an authority that could set one"
    },
    {
      "code": 6035,
      "name": "mintHasFeeAuthority",
      "msg": "Mint has a transfer fee authority that could raise the fee"
    },
    {
      "code": 6036,
      "name": "mintHasCloseAuthority",
      "msg": "Mint has a close authority"
    },
    {
      "code": 6037,
      "name": "mintDefaultFrozen",
      "msg": "Mint's default account state is frozen"
    },
    {
      "code": 6038,
      "name": "mintMismatch",
      "msg": "Mint does not match this asset"
    },
    {
      "code": 6039,
      "name": "vaultMismatch",
      "msg": "Vault does not match this asset"
    },
    {
      "code": 6040,
      "name": "invalidStatus",
      "msg": "Asset is not in the required status"
    },
    {
      "code": 6041,
      "name": "underfunded",
      "msg": "Vault balance is below the committed allocation"
    },
    {
      "code": 6042,
      "name": "roundExpired",
      "msg": "Round has expired"
    },
    {
      "code": 6043,
      "name": "roundNotExpired",
      "msg": "Round has not expired"
    },
    {
      "code": 6044,
      "name": "leafIndexOutOfRange",
      "msg": "leaf_idx is out of range for this asset"
    },
    {
      "code": 6045,
      "name": "alreadyClaimed",
      "msg": "This leaf has already been paid"
    },
    {
      "code": 6046,
      "name": "invalidProof",
      "msg": "Payout proof does not match the asset's merkle_root"
    },
    {
      "code": 6047,
      "name": "zeroAmount",
      "msg": "Payout amount must be greater than zero"
    },
    {
      "code": 6048,
      "name": "exceedsAllocation",
      "msg": "Payout would exceed the asset's committed allocation"
    },
    {
      "code": 6049,
      "name": "claimDestinationMismatch",
      "msg": "Destination token account is not owned by the recipient"
    },
    {
      "code": 6050,
      "name": "destinationNotCanonicalAta",
      "msg": "Push payouts must go to the recipient's canonical associated token account"
    },
    {
      "code": 6051,
      "name": "rolloverMismatch",
      "msg": "Rollover destination does not match the root authority"
    },
    {
      "code": 6052,
      "name": "nothingToSweep",
      "msg": "Vault holds nothing beyond what is still owed"
    },
    {
      "code": 6053,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6054,
      "name": "invalidBlock",
      "msg": "Payout block is misaligned, the wrong size, or has the wrong destination accounts"
    },
    {
      "code": 6055,
      "name": "notPythFeedAccount",
      "msg": "Price feed account must be Pyth's push-oracle account (shard 0) for the price feed id"
    },
    {
      "code": 6056,
      "name": "priceFromTheFuture",
      "msg": "Price update is stamped further in the future than the price age limit allows"
    },
    {
      "code": 6057,
      "name": "mintTransferFeeTooHigh",
      "msg": "Mint's transfer fee, current or scheduled, is above MAX_TRANSFER_FEE_BPS"
    },
    {
      "code": 6058,
      "name": "destinationIsVault",
      "msg": "A payout can't go to the asset's own vault or name the asset account as its recipient"
    },
    {
      "code": 6059,
      "name": "invalidRootAuthority",
      "msg": "Proposed root authority must be a real key different from the current one"
    }
  ],
  "types": [
    {
      "name": "abandonReason",
      "docs": [
        "Why a round was abandoned, as emitted in `RoundAbandoned`."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "windowOpen"
          },
          {
            "name": "seedExpired"
          },
          {
            "name": "secretLost"
          }
        ]
      }
    },
    {
      "name": "assetActivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "funded",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "assetClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "returned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "assetOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "allocated",
            "type": "u64"
          },
          {
            "name": "leafCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "assetStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "active"
          }
        ]
      }
    },
    {
      "name": "blockLeaf",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "push",
            "fields": [
              {
                "name": "amount",
                "type": "u64"
              }
            ]
          },
          {
            "name": "skip",
            "fields": [
              {
                "name": "recipient",
                "type": "pubkey"
              },
              {
                "name": "amount",
                "type": "u64"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "commitRoundParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "secret",
            "docs": [
              "Revealed sampling secret; must hash to the intent's commitment."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assetsRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "artifactHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assetCount",
            "docs": [
              "Zero is allowed: a seeded round with nothing to pay still gets committed."
            ],
            "type": "u8"
          },
          {
            "name": "expiryTs",
            "type": "i64"
          },
          {
            "name": "allowFreezeAuthorityMask",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "createDistributorParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "minExpirySecs",
            "type": "i64"
          },
          {
            "name": "policyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priceFeedAccount",
            "type": "pubkey"
          },
          {
            "name": "priceFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxPriceAgeSecs",
            "type": "u32"
          },
          {
            "name": "maxPriceConfBps",
            "type": "u16"
          },
          {
            "name": "seedSlotOffset",
            "type": "u16"
          },
          {
            "name": "minWindowSecs",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "distributor",
      "docs": [
        "One per launched index coin. Seeded by `(index_mint, creator)`, so anyone",
        "can create a distributor but never under someone else's key — no global",
        "admin decides who may launch, and nobody can squat another keeper's slot.",
        "",
        "Everything a round's allocation depends on besides the snapshots is fixed",
        "here at creation: the published round policy (by hash), the SOL/USD price",
        "feed and its freshness rules, and the sampling timing rules."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "indexMint",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "docs": [
              "Original root authority; part of the PDA seeds, never changes."
            ],
            "type": "pubkey"
          },
          {
            "name": "rootAuthority",
            "docs": [
              "The automated keeper: runs rounds and receives excess and expired",
              "funds to roll into the next round. The only key with any power here."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingRootAuthority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "minExpirySecs",
            "docs": [
              "Fixed at creation: every round stays claimable at least this long."
            ],
            "type": "i64"
          },
          {
            "name": "nextRoundId",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "policyHash",
            "docs": [
              "sha256 of the canonical round policy JSON every round must publish."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priceFeedAccount",
            "docs": [
              "Pyth PriceUpdateV2 account read when a round's window closes."
            ],
            "type": "pubkey"
          },
          {
            "name": "priceFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxPriceAgeSecs",
            "type": "u32"
          },
          {
            "name": "maxPriceConfBps",
            "type": "u16"
          },
          {
            "name": "seedSlotOffset",
            "docs": [
              "Slots after a window closes before the block whose hash seeds sampling."
            ],
            "type": "u16"
          },
          {
            "name": "minWindowSecs",
            "type": "u32"
          },
          {
            "name": "expiredSeedAbandons",
            "docs": [
              "Rounds abandoned because their seed block aged out unrecorded — each one",
              "a possible re-draw, so it is kept as a public count."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "distributorCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "indexMint",
            "type": "pubkey"
          },
          {
            "name": "rootAuthority",
            "type": "pubkey"
          },
          {
            "name": "minExpirySecs",
            "type": "i64"
          },
          {
            "name": "policyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "excessSwept",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "intentStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "closed"
          },
          {
            "name": "seeded"
          },
          {
            "name": "committed"
          },
          {
            "name": "abandoned"
          }
        ]
      }
    },
    {
      "name": "openAssetParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "allocated",
            "type": "u64"
          },
          {
            "name": "leafCount",
            "type": "u32"
          },
          {
            "name": "assetProof",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "payoutEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "leafIdx",
            "type": "u32"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "selfClaim",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "pushPayoutsParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "firstLeaf",
            "docs": [
              "First leaf of the block; must be a multiple of 2^level."
            ],
            "type": "u32"
          },
          {
            "name": "level",
            "type": "u8"
          },
          {
            "name": "leaves",
            "docs": [
              "Every leaf in the block, in order."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "blockLeaf"
                }
              }
            }
          },
          {
            "name": "proof",
            "docs": [
              "Siblings of the block's subtree root on the way up to the asset root."
            ],
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "rootAuthorityRotated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "previous",
            "type": "pubkey"
          },
          {
            "name": "new",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "roundAbandoned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": {
              "defined": {
                "name": "abandonReason"
              }
            }
          },
          {
            "name": "expiredSeedAbandons",
            "docs": [
              "The distributor's running count of seed-expired abandons, after this one."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "roundAsset",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetIdx",
            "type": "u8"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "assetStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "merkleRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "allocated",
            "type": "u64"
          },
          {
            "name": "funded",
            "type": "u64"
          },
          {
            "name": "claimed",
            "type": "u64"
          },
          {
            "name": "leafCount",
            "type": "u32"
          },
          {
            "name": "bitmap",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "roundCommitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetsRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "artifactHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assetCount",
            "type": "u8"
          },
          {
            "name": "expiryTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "roundHeader",
      "docs": [
        "Kept forever as the public record of what each round committed to."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "assetsRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "artifactHash",
            "docs": [
              "sha256 of the round's canonical manifest.json."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assetCount",
            "type": "u8"
          },
          {
            "name": "openedMask",
            "type": "u32"
          },
          {
            "name": "closedMask",
            "type": "u32"
          },
          {
            "name": "allowFreezeAuthorityMask",
            "type": "u32"
          },
          {
            "name": "committedTs",
            "type": "i64"
          },
          {
            "name": "expiryTs",
            "type": "i64"
          },
          {
            "name": "windowStartSlot",
            "type": "u64"
          },
          {
            "name": "windowEndSlot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "roundIntent",
      "docs": [
        "The on-chain record that makes a round's sampling tamper-evident: the",
        "keeper commits its secret before snapshots, the program records the window",
        "and price at close, and the program — not the keeper — picks the seed block."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "intentStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "secretCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "openSlot",
            "type": "u64"
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "closeSlot",
            "type": "u64"
          },
          {
            "name": "closeTs",
            "type": "i64"
          },
          {
            "name": "snapshotChainHead",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "snapshotCount",
            "type": "u32"
          },
          {
            "name": "solUsdPrice",
            "type": "i64"
          },
          {
            "name": "solUsdConf",
            "type": "u64"
          },
          {
            "name": "solUsdExponent",
            "type": "i32"
          },
          {
            "name": "solUsdPublishTime",
            "type": "i64"
          },
          {
            "name": "seedSlot",
            "type": "u64"
          },
          {
            "name": "seedHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "seedTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "roundOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "secretCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "openSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "seedRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "seedSlot",
            "type": "u64"
          },
          {
            "name": "seedHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "windowClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "distributor",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "closeSlot",
            "type": "u64"
          },
          {
            "name": "snapshotCount",
            "type": "u32"
          },
          {
            "name": "snapshotChainHead",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "solUsdPrice",
            "type": "i64"
          },
          {
            "name": "solUsdExponent",
            "type": "i32"
          }
        ]
      }
    }
  ]
};

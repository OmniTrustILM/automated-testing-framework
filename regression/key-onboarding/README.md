# Key onboarding regression suite

Exercises listing the key pairs on a PKCS#11 token and onboarding them into the inventory, end
to end: Core, the PKCS#11 connector, its proxy sidecar and a SoftHSM token.

The suite runs against a stack that is already up.

```bash
cp config.env.example config.env    # once: Core, the administrator certificate, the connectors
./run.sh                            # every run; arguments go to Playwright
```

## What a run does

The global setup finds or creates what the specs need: the connector registrations, a vault
holding the token's PIN, a token on the PKCS#11 connector and an enabled token profile. It then
plants fresh key pairs on the token, the way a tool outside the platform would, under labels
unique to the run. Each run therefore starts from key pairs the inventory has never seen, and
the token keeps every earlier run's key pairs.

The specs list the token, onboard the planted key pairs, sign with them through Core and remove
them from the inventory again, one at a time and in bulk. One pair's public key reaches the
inventory first, through a certificate, and onboarding adds its private key to that key.

Each run writes its report and results to `runs/<timestamp>/`, with `runs/latest` pointing at
the newest.

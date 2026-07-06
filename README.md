# Ekubo Yul Router

Gas-focused Yul router for Ekubo EVM swaps.

The router deliberately carries token addresses, pool configs, extension forwardee addresses, and token wrapper addresses in calldata. It does not use token or extension jump tables, does not expose fee claiming, rejects Core `forward` calls to itself, and rejects delegatecall execution by checking an immutable self address appended at deployment.

## Calldata

The SDK exports `encodeRoute(...)` and emits custom packed calldata with selector `0x00000002`.

Supported hop types:

- `core`: direct `Core.swap_6269342730()` using the provided pool key.
- `forwarded`: `Core.forward(forwardee, abi.encode(poolKey, params))` for MEV-capture-compatible forwarded swap extensions.
- `ve33`: `Core.forward(forwardee, abi.encode(uint256(0), poolKey, params))` for Ve33-compatible pools that prefix forwarded swap data with a call type.
- `wrapper`: `Core.forward(wrapper, abi.encode(int256 amount))` for Ekubo token wrappers.

Constructor argument:

- `core: address`

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

address constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

function getCreate2Address(bytes32 salt, bytes32 initCodeHash) pure returns (address) {
    return
        address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), DETERMINISTIC_DEPLOYER, salt, initCodeHash)))));
}

error DeploymentFailed(address expected);

/// @title DeployYulRouter
/// @notice Deploys the Yul router configured for the canonical Ekubo Core address.
contract DeployYulRouter is Script {
    address payable public constant CANONICAL_CORE = payable(0x00000000000014aA86C5d3c41765bb24e11bd701);

    function run() external returns (address router) {
        bytes32 salt = vm.envOr("SALT", bytes32(0x219ff70131cd3966c17874e905d63eab90496169d03582fd7da3ae80e48c4459));
        bytes memory initcode = vm.parseJsonBytes(vm.readFile("out/YulRouter.yul/YulRouter.json"), ".bytecode.object");
        bytes memory code = bytes.concat(initcode, abi.encode(CANONICAL_CORE));
        bytes32 initCodeHash = keccak256(code);

        router = getCreate2Address(salt, initCodeHash);

        console2.log("deployer", DETERMINISTIC_DEPLOYER);
        console2.log("salt");
        console2.logBytes32(salt);
        console2.log("initCodeHash");
        console2.logBytes32(initCodeHash);
        console2.log("expectedAddress", router);

        vm.startBroadcast();
        if (router.code.length == 0) {
            (bool success,) = DETERMINISTIC_DEPLOYER.call(bytes.concat(salt, code));
            if (!success || router.code.length == 0) {
                revert DeploymentFailed(router);
            }
        }
        vm.stopBroadcast();
    }
}

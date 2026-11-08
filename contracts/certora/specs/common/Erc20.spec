// The token is OpenZeppelin's ERC20 (`Erc20Token`): the Prover cannot fork the chain to run PYUSD itself.

using Erc20Token as token;

methods {
    function token.balanceOf(address) external returns (uint256) envfree;
    function token.allowance(address, address) external returns (uint256) envfree;
    function token.totalSupply() external returns (uint256) envfree;

    // SafeERC20 and OpenZeppelin's authority and ERC-1271 helpers call through inline assembly, so the Prover cannot
    // read the selector. Token calls go to the token's own code; any other such call is a staticcall to a view
    // (`canCall`, `isValidSignature`), which NONDET models soundly.
    unresolved external in _._ => DISPATCH [
        token.transfer(address, uint256),
        token.transferFrom(address, address, uint256)
    ] default NONDET;
}

// ERC20 adds to the recipient's balance unchecked, relying on the sum of balances never exceeding the total supply
// (proven for OpenZeppelin's ERC20 by its own Certora specs); an arbitrary initial token state must respect it.
function requireNoBalanceOverflow(address a, address b) {
    require a == b || token.balanceOf(a) + token.balanceOf(b) <= to_mathint(token.totalSupply()),
        "two distinct balances never exceed the total supply";
}

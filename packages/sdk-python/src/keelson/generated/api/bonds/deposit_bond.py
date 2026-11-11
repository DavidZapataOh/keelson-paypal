from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.bond_deposit_type_0 import BondDepositType0
from ...models.bond_deposit_type_1 import BondDepositType1
from ...models.problem import Problem
from ...models.transaction import Transaction
from ...types import Response


def _get_kwargs(
    agent_id: str,
    *,
    body: BondDepositType0 | BondDepositType1,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/bonds/{agent_id}/deposits".format(
            agent_id=quote(str(agent_id), safe=""),
        ),
    }

    if isinstance(body, BondDepositType0):
        _kwargs["json"] = body.to_dict()
    else:
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | Transaction | None:
    if response.status_code == 200:
        response_200 = Transaction.from_dict(response.json())

        return response_200

    if response.status_code == 202:
        response_202 = Transaction.from_dict(response.json())

        return response_202

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | Transaction]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: BondDepositType0 | BondDepositType1,
) -> Response[Problem | Transaction]:
    """Deposit PYUSD into an operator's bond, gasless

     Relays `depositWithAuthorization` (EIP-3009) or `depositWithPermit` (EIP-2612) to the bond vault;
    Keelson pays the gas. The same authorization is sent once, whatever the idempotency key. An
    `operators:write` client sends either; the operator's own session (EIP-4361, from the operator
    console) sends a permit whose `owner` is a wallet it signed in with that owns the agent.

    Args:
        agent_id (str): The ERC-8004 agent id, a decimal integer.
        body (BondDepositType0 | BondDepositType1):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Transaction]
    """

    kwargs = _get_kwargs(
        agent_id=agent_id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: BondDepositType0 | BondDepositType1,
) -> Problem | Transaction | None:
    """Deposit PYUSD into an operator's bond, gasless

     Relays `depositWithAuthorization` (EIP-3009) or `depositWithPermit` (EIP-2612) to the bond vault;
    Keelson pays the gas. The same authorization is sent once, whatever the idempotency key. An
    `operators:write` client sends either; the operator's own session (EIP-4361, from the operator
    console) sends a permit whose `owner` is a wallet it signed in with that owns the agent.

    Args:
        agent_id (str): The ERC-8004 agent id, a decimal integer.
        body (BondDepositType0 | BondDepositType1):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Transaction
    """

    return sync_detailed(
        agent_id=agent_id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: BondDepositType0 | BondDepositType1,
) -> Response[Problem | Transaction]:
    """Deposit PYUSD into an operator's bond, gasless

     Relays `depositWithAuthorization` (EIP-3009) or `depositWithPermit` (EIP-2612) to the bond vault;
    Keelson pays the gas. The same authorization is sent once, whatever the idempotency key. An
    `operators:write` client sends either; the operator's own session (EIP-4361, from the operator
    console) sends a permit whose `owner` is a wallet it signed in with that owns the agent.

    Args:
        agent_id (str): The ERC-8004 agent id, a decimal integer.
        body (BondDepositType0 | BondDepositType1):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Transaction]
    """

    kwargs = _get_kwargs(
        agent_id=agent_id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    agent_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: BondDepositType0 | BondDepositType1,
) -> Problem | Transaction | None:
    """Deposit PYUSD into an operator's bond, gasless

     Relays `depositWithAuthorization` (EIP-3009) or `depositWithPermit` (EIP-2612) to the bond vault;
    Keelson pays the gas. The same authorization is sent once, whatever the idempotency key. An
    `operators:write` client sends either; the operator's own session (EIP-4361, from the operator
    console) sends a permit whose `owner` is a wallet it signed in with that owns the agent.

    Args:
        agent_id (str): The ERC-8004 agent id, a decimal integer.
        body (BondDepositType0 | BondDepositType1):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Transaction
    """

    return (
        await asyncio_detailed(
            agent_id=agent_id,
            client=client,
            body=body,
        )
    ).parsed

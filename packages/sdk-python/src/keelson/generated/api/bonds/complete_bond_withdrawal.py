from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.complete_bond_withdrawal_chain_id import (
    CompleteBondWithdrawalChainId,
)
from ...models.problem import Problem
from ...models.transaction import Transaction
from ...types import Response


def _get_kwargs(
    chain_id: CompleteBondWithdrawalChainId,
    withdrawal_id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/bonds/withdrawals/{chain_id}/{withdrawal_id}/complete".format(
            chain_id=quote(str(chain_id), safe=""),
            withdrawal_id=quote(str(withdrawal_id), safe=""),
        ),
    }

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
    chain_id: CompleteBondWithdrawalChainId,
    withdrawal_id: str,
    *,
    client: AuthenticatedClient,
) -> Response[Problem | Transaction]:
    """Complete a queued withdrawal, gasless

     Relays `completeWithdrawal`, which anyone may call once the delay ended; it pays only the signed
    recipient.

    Args:
        chain_id (CompleteBondWithdrawalChainId):
        withdrawal_id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Transaction]
    """

    kwargs = _get_kwargs(
        chain_id=chain_id,
        withdrawal_id=withdrawal_id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    chain_id: CompleteBondWithdrawalChainId,
    withdrawal_id: str,
    *,
    client: AuthenticatedClient,
) -> Problem | Transaction | None:
    """Complete a queued withdrawal, gasless

     Relays `completeWithdrawal`, which anyone may call once the delay ended; it pays only the signed
    recipient.

    Args:
        chain_id (CompleteBondWithdrawalChainId):
        withdrawal_id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Transaction
    """

    return sync_detailed(
        chain_id=chain_id,
        withdrawal_id=withdrawal_id,
        client=client,
    ).parsed


async def asyncio_detailed(
    chain_id: CompleteBondWithdrawalChainId,
    withdrawal_id: str,
    *,
    client: AuthenticatedClient,
) -> Response[Problem | Transaction]:
    """Complete a queued withdrawal, gasless

     Relays `completeWithdrawal`, which anyone may call once the delay ended; it pays only the signed
    recipient.

    Args:
        chain_id (CompleteBondWithdrawalChainId):
        withdrawal_id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | Transaction]
    """

    kwargs = _get_kwargs(
        chain_id=chain_id,
        withdrawal_id=withdrawal_id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    chain_id: CompleteBondWithdrawalChainId,
    withdrawal_id: str,
    *,
    client: AuthenticatedClient,
) -> Problem | Transaction | None:
    """Complete a queued withdrawal, gasless

     Relays `completeWithdrawal`, which anyone may call once the delay ended; it pays only the signed
    recipient.

    Args:
        chain_id (CompleteBondWithdrawalChainId):
        withdrawal_id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | Transaction
    """

    return (
        await asyncio_detailed(
            chain_id=chain_id,
            withdrawal_id=withdrawal_id,
            client=client,
        )
    ).parsed

from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.set_settlement_response_200 import SetSettlementResponse200
from ...models.signed_settlement_preference import SignedSettlementPreference
from ...types import Response


def _get_kwargs(
    merchant_id: str,
    *,
    body: SignedSettlementPreference,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/merchants/{merchant_id}/settlement".format(
            merchant_id=quote(str(merchant_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | SetSettlementResponse200 | None:
    if response.status_code == 200:
        response_200 = SetSettlementResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | SetSettlementResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    merchant_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: SignedSettlementPreference,
) -> Response[Problem | SetSettlementResponse200]:
    """Choose how a merchant is paid when a dispute goes its way

     Applies to verdicts signed afterwards: the rail decides the payee the TEE legs sign into the
    `Verdict`. The merchant signs the choice, as it signs its on-chain payout address. Sent by a client
    with `merchants:write` or by the merchant's own session.

    Args:
        merchant_id (str):
        body (SignedSettlementPreference):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | SetSettlementResponse200]
    """

    kwargs = _get_kwargs(
        merchant_id=merchant_id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    merchant_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: SignedSettlementPreference,
) -> Problem | SetSettlementResponse200 | None:
    """Choose how a merchant is paid when a dispute goes its way

     Applies to verdicts signed afterwards: the rail decides the payee the TEE legs sign into the
    `Verdict`. The merchant signs the choice, as it signs its on-chain payout address. Sent by a client
    with `merchants:write` or by the merchant's own session.

    Args:
        merchant_id (str):
        body (SignedSettlementPreference):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | SetSettlementResponse200
    """

    return sync_detailed(
        merchant_id=merchant_id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    merchant_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: SignedSettlementPreference,
) -> Response[Problem | SetSettlementResponse200]:
    """Choose how a merchant is paid when a dispute goes its way

     Applies to verdicts signed afterwards: the rail decides the payee the TEE legs sign into the
    `Verdict`. The merchant signs the choice, as it signs its on-chain payout address. Sent by a client
    with `merchants:write` or by the merchant's own session.

    Args:
        merchant_id (str):
        body (SignedSettlementPreference):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | SetSettlementResponse200]
    """

    kwargs = _get_kwargs(
        merchant_id=merchant_id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    merchant_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: SignedSettlementPreference,
) -> Problem | SetSettlementResponse200 | None:
    """Choose how a merchant is paid when a dispute goes its way

     Applies to verdicts signed afterwards: the rail decides the payee the TEE legs sign into the
    `Verdict`. The merchant signs the choice, as it signs its on-chain payout address. Sent by a client
    with `merchants:write` or by the merchant's own session.

    Args:
        merchant_id (str):
        body (SignedSettlementPreference):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | SetSettlementResponse200
    """

    return (
        await asyncio_detailed(
            merchant_id=merchant_id,
            client=client,
            body=body,
        )
    ).parsed

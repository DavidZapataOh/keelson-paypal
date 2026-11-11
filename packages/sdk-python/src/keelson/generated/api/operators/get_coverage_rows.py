from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.coverage_rows_request import CoverageRowsRequest
from ...models.get_coverage_rows_response_200 import GetCoverageRowsResponse200
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    agent_id: str,
    *,
    body: CoverageRowsRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/operators/{agent_id}/coverages/rows".format(
            agent_id=quote(str(agent_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> GetCoverageRowsResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = GetCoverageRowsResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[GetCoverageRowsResponse200 | Problem]:
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
    body: CoverageRowsRequest,
) -> Response[GetCoverageRowsResponse200 | Problem]:
    """A block of the operator's coverages, for AG Grid's server-side row model

     The operator's covered purchases with their latest dispute and verdict, filtered, sorted and paged
    as AG Grid asks. `rowCount` is the filtered total. A read: no idempotency key.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.
        body (CoverageRowsRequest): AG Grid's `IServerSideGetRowsRequest`: the block, its sort and
            its filter model (text, number, date and set filters). Amounts are filtered in US dollars.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[GetCoverageRowsResponse200 | Problem]
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
    body: CoverageRowsRequest,
) -> GetCoverageRowsResponse200 | Problem | None:
    """A block of the operator's coverages, for AG Grid's server-side row model

     The operator's covered purchases with their latest dispute and verdict, filtered, sorted and paged
    as AG Grid asks. `rowCount` is the filtered total. A read: no idempotency key.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.
        body (CoverageRowsRequest): AG Grid's `IServerSideGetRowsRequest`: the block, its sort and
            its filter model (text, number, date and set filters). Amounts are filtered in US dollars.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        GetCoverageRowsResponse200 | Problem
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
    body: CoverageRowsRequest,
) -> Response[GetCoverageRowsResponse200 | Problem]:
    """A block of the operator's coverages, for AG Grid's server-side row model

     The operator's covered purchases with their latest dispute and verdict, filtered, sorted and paged
    as AG Grid asks. `rowCount` is the filtered total. A read: no idempotency key.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.
        body (CoverageRowsRequest): AG Grid's `IServerSideGetRowsRequest`: the block, its sort and
            its filter model (text, number, date and set filters). Amounts are filtered in US dollars.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[GetCoverageRowsResponse200 | Problem]
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
    body: CoverageRowsRequest,
) -> GetCoverageRowsResponse200 | Problem | None:
    """A block of the operator's coverages, for AG Grid's server-side row model

     The operator's covered purchases with their latest dispute and verdict, filtered, sorted and paged
    as AG Grid asks. `rowCount` is the filtered total. A read: no idempotency key.

    Args:
        agent_id (str): The operator's ERC-8004 agent id, a decimal integer.
        body (CoverageRowsRequest): AG Grid's `IServerSideGetRowsRequest`: the block, its sort and
            its filter model (text, number, date and set filters). Amounts are filtered in US dollars.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        GetCoverageRowsResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            agent_id=agent_id,
            client=client,
            body=body,
        )
    ).parsed

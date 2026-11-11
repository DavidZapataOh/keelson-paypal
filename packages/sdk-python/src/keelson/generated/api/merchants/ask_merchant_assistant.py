from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.assistant_turn import AssistantTurn
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    merchant_id: str,
    *,
    body: AssistantTurn,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/merchants/{merchant_id}/assistant".format(
            merchant_id=quote(str(merchant_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | None:
    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if response.status_code == 502:
        response_502 = Problem.from_dict(response.json())

        return response_502

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem]:
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
    body: AssistantTurn,
) -> Response[Problem]:
    """One streamed model turn for the merchant console's agents

     Streams the Messages API events as newline-delimited JSON (the Anthropic SDK's
    `MessageStream.toReadableStream`). Each merchant has a daily budget; once it is spent the turn runs
    on `claude-haiku-5-5`, named in `Keelson-Model`.

    Args:
        merchant_id (str):
        body (AssistantTurn): One turn of the console's agents: Messages API `system`, `messages`
            and client `tools`. The proxy sets the model limits, thinking and effort.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem]
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
    body: AssistantTurn,
) -> Problem | None:
    """One streamed model turn for the merchant console's agents

     Streams the Messages API events as newline-delimited JSON (the Anthropic SDK's
    `MessageStream.toReadableStream`). Each merchant has a daily budget; once it is spent the turn runs
    on `claude-haiku-5-5`, named in `Keelson-Model`.

    Args:
        merchant_id (str):
        body (AssistantTurn): One turn of the console's agents: Messages API `system`, `messages`
            and client `tools`. The proxy sets the model limits, thinking and effort.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem
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
    body: AssistantTurn,
) -> Response[Problem]:
    """One streamed model turn for the merchant console's agents

     Streams the Messages API events as newline-delimited JSON (the Anthropic SDK's
    `MessageStream.toReadableStream`). Each merchant has a daily budget; once it is spent the turn runs
    on `claude-haiku-5-5`, named in `Keelson-Model`.

    Args:
        merchant_id (str):
        body (AssistantTurn): One turn of the console's agents: Messages API `system`, `messages`
            and client `tools`. The proxy sets the model limits, thinking and effort.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem]
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
    body: AssistantTurn,
) -> Problem | None:
    """One streamed model turn for the merchant console's agents

     Streams the Messages API events as newline-delimited JSON (the Anthropic SDK's
    `MessageStream.toReadableStream`). Each merchant has a daily budget; once it is spent the turn runs
    on `claude-haiku-5-5`, named in `Keelson-Model`.

    Args:
        merchant_id (str):
        body (AssistantTurn): One turn of the console's agents: Messages API `system`, `messages`
            and client `tools`. The proxy sets the model limits, thinking and effort.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem
    """

    return (
        await asyncio_detailed(
            merchant_id=merchant_id,
            client=client,
            body=body,
        )
    ).parsed

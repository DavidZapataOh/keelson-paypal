from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.embed_connection_body import EmbedConnectionBody
from ...models.embed_url import EmbedUrl
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: EmbedConnectionBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/connections/embed",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> EmbedUrl | Problem | None:
    if response.status_code == 201:
        response_201 = EmbedUrl.from_dict(response.json())

        return response_201

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[EmbedUrl | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: EmbedConnectionBody,
) -> Response[EmbedUrl | Problem]:
    """Embed the approval of a request

     For a pending request this client made, a URL to frame in the agent platform's page at `origin`, one
    of the client's embed origins. The URL's fragment carries a single-use token the frame redeems
    within five minutes; mint another to frame it again. The user approves in a Keelson window the frame
    opens, with a passkey; poll `POST /v1/connections/token` as usual for the answer.

    Args:
        body (EmbedConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedUrl | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    body: EmbedConnectionBody,
) -> EmbedUrl | Problem | None:
    """Embed the approval of a request

     For a pending request this client made, a URL to frame in the agent platform's page at `origin`, one
    of the client's embed origins. The URL's fragment carries a single-use token the frame redeems
    within five minutes; mint another to frame it again. The user approves in a Keelson window the frame
    opens, with a passkey; poll `POST /v1/connections/token` as usual for the answer.

    Args:
        body (EmbedConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedUrl | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: EmbedConnectionBody,
) -> Response[EmbedUrl | Problem]:
    """Embed the approval of a request

     For a pending request this client made, a URL to frame in the agent platform's page at `origin`, one
    of the client's embed origins. The URL's fragment carries a single-use token the frame redeems
    within five minutes; mint another to frame it again. The user approves in a Keelson window the frame
    opens, with a passkey; poll `POST /v1/connections/token` as usual for the answer.

    Args:
        body (EmbedConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedUrl | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: EmbedConnectionBody,
) -> EmbedUrl | Problem | None:
    """Embed the approval of a request

     For a pending request this client made, a URL to frame in the agent platform's page at `origin`, one
    of the client's embed origins. The URL's fragment carries a single-use token the frame redeems
    within five minutes; mint another to frame it again. The user approves in a Keelson window the frame
    opens, with a passkey; poll `POST /v1/connections/token` as usual for the answer.

    Args:
        body (EmbedConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedUrl | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed

from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.confirm_embed_link_body import ConfirmEmbedLinkBody
from ...models.embed_linked import EmbedLinked
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    *,
    body: ConfirmEmbedLinkBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/embed/links/confirm",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> EmbedLinked | Problem | None:
    if response.status_code == 200:
        response_200 = EmbedLinked.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[EmbedLinked | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: ConfirmEmbedLinkBody,
) -> Response[EmbedLinked | Problem]:
    """Confirm a link from the Keelson window

     The signed-in user confirms the embedded approval that opened this window, named by its `ref`. The
    answer is a single-use grant the window hands only to that frame, its opener on Keelson's origin;
    the frame claims it with `POST /v1/embed/links/claim`. The frame may create a passkey only for a
    user who has none.

    Args:
        body (ConfirmEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedLinked | Problem]
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
    body: ConfirmEmbedLinkBody,
) -> EmbedLinked | Problem | None:
    """Confirm a link from the Keelson window

     The signed-in user confirms the embedded approval that opened this window, named by its `ref`. The
    answer is a single-use grant the window hands only to that frame, its opener on Keelson's origin;
    the frame claims it with `POST /v1/embed/links/claim`. The frame may create a passkey only for a
    user who has none.

    Args:
        body (ConfirmEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedLinked | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: ConfirmEmbedLinkBody,
) -> Response[EmbedLinked | Problem]:
    """Confirm a link from the Keelson window

     The signed-in user confirms the embedded approval that opened this window, named by its `ref`. The
    answer is a single-use grant the window hands only to that frame, its opener on Keelson's origin;
    the frame claims it with `POST /v1/embed/links/claim`. The frame may create a passkey only for a
    user who has none.

    Args:
        body (ConfirmEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedLinked | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: ConfirmEmbedLinkBody,
) -> EmbedLinked | Problem | None:
    """Confirm a link from the Keelson window

     The signed-in user confirms the embedded approval that opened this window, named by its `ref`. The
    answer is a single-use grant the window hands only to that frame, its opener on Keelson's origin;
    the frame claims it with `POST /v1/embed/links/claim`. The frame may create a passkey only for a
    user who has none.

    Args:
        body (ConfirmEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedLinked | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed

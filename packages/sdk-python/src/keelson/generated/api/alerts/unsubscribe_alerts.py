from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.unsubscribe_alerts_response_200 import UnsubscribeAlertsResponse200
from ...types import UNSET, Response


def _get_kwargs(
    *,
    token: str,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["token"] = token

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/alerts/unsubscribe",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | UnsubscribeAlertsResponse200 | None:
    if response.status_code == 200:
        response_200 = UnsubscribeAlertsResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | UnsubscribeAlertsResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    token: str,
) -> Response[Problem | UnsubscribeAlertsResponse200]:
    """Unsubscribe in one click

     The `List-Unsubscribe` URI of every alert email (RFC 8058): the mail client posts `List-
    Unsubscribe=One-Click` to it, with no session or other context. The token in the query names the
    address.

    Args:
        token (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | UnsubscribeAlertsResponse200]
    """

    kwargs = _get_kwargs(
        token=token,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    token: str,
) -> Problem | UnsubscribeAlertsResponse200 | None:
    """Unsubscribe in one click

     The `List-Unsubscribe` URI of every alert email (RFC 8058): the mail client posts `List-
    Unsubscribe=One-Click` to it, with no session or other context. The token in the query names the
    address.

    Args:
        token (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | UnsubscribeAlertsResponse200
    """

    return sync_detailed(
        client=client,
        token=token,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    token: str,
) -> Response[Problem | UnsubscribeAlertsResponse200]:
    """Unsubscribe in one click

     The `List-Unsubscribe` URI of every alert email (RFC 8058): the mail client posts `List-
    Unsubscribe=One-Click` to it, with no session or other context. The token in the query names the
    address.

    Args:
        token (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | UnsubscribeAlertsResponse200]
    """

    kwargs = _get_kwargs(
        token=token,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    token: str,
) -> Problem | UnsubscribeAlertsResponse200 | None:
    """Unsubscribe in one click

     The `List-Unsubscribe` URI of every alert email (RFC 8058): the mail client posts `List-
    Unsubscribe=One-Click` to it, with no session or other context. The token in the query names the
    address.

    Args:
        token (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | UnsubscribeAlertsResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
            token=token,
        )
    ).parsed

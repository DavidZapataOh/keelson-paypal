from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.alert_email import AlertEmail
from ...models.problem import Problem
from ...models.set_alert_email_body import SetAlertEmailBody
from ...types import Response


def _get_kwargs(
    *,
    body: SetAlertEmailBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/alerts/email",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> AlertEmail | Problem | None:
    if response.status_code == 202:
        response_202 = AlertEmail.from_dict(response.json())

        return response_202

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[AlertEmail | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: SetAlertEmailBody,
) -> Response[AlertEmail | Problem]:
    """Set your alert address

     Stores the address unconfirmed and sends it a confirmation link, signed, single use and valid for 24
    hours. Alerts are emailed only once it is confirmed. Never the sign-in address unless entered here.

    Args:
        body (SetAlertEmailBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AlertEmail | Problem]
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
    body: SetAlertEmailBody,
) -> AlertEmail | Problem | None:
    """Set your alert address

     Stores the address unconfirmed and sends it a confirmation link, signed, single use and valid for 24
    hours. Alerts are emailed only once it is confirmed. Never the sign-in address unless entered here.

    Args:
        body (SetAlertEmailBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AlertEmail | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: SetAlertEmailBody,
) -> Response[AlertEmail | Problem]:
    """Set your alert address

     Stores the address unconfirmed and sends it a confirmation link, signed, single use and valid for 24
    hours. Alerts are emailed only once it is confirmed. Never the sign-in address unless entered here.

    Args:
        body (SetAlertEmailBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AlertEmail | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: SetAlertEmailBody,
) -> AlertEmail | Problem | None:
    """Set your alert address

     Stores the address unconfirmed and sends it a confirmation link, signed, single use and valid for 24
    hours. Alerts are emailed only once it is confirmed. Never the sign-in address unless entered here.

    Args:
        body (SetAlertEmailBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AlertEmail | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed

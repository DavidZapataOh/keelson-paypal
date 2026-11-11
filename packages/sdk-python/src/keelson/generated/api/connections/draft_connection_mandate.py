from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.connection_draft import ConnectionDraft
from ...models.draft_connection_mandate_response_200 import DraftConnectionMandateResponse200
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    code: str,
    *,
    body: ConnectionDraft,
    keelson_device: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(keelson_device, Unset):
        headers["keelson-device"] = keelson_device

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/connections/{code}/draft".format(
            code=quote(str(code), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> DraftConnectionMandateResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = DraftConnectionMandateResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

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
) -> Response[DraftConnectionMandateResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    code: str,
    *,
    client: AuthenticatedClient,
    body: ConnectionDraft,
    keelson_device: str | Unset = UNSET,
) -> Response[DraftConnectionMandateResponse200 | Problem]:
    """Draft the mandate that approves a request

     The unsigned mandate for the limits the user chose, which may only be lower than or equal to what
    the agent asked. It names the asking agent's operator. Sign it and store it with `POST
    /v1/mandates`, passing `connection`, to approve.

    Args:
        code (str):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DraftConnectionMandateResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        code=code,
        body=body,
        keelson_device=keelson_device,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    code: str,
    *,
    client: AuthenticatedClient,
    body: ConnectionDraft,
    keelson_device: str | Unset = UNSET,
) -> DraftConnectionMandateResponse200 | Problem | None:
    """Draft the mandate that approves a request

     The unsigned mandate for the limits the user chose, which may only be lower than or equal to what
    the agent asked. It names the asking agent's operator. Sign it and store it with `POST
    /v1/mandates`, passing `connection`, to approve.

    Args:
        code (str):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DraftConnectionMandateResponse200 | Problem
    """

    return sync_detailed(
        code=code,
        client=client,
        body=body,
        keelson_device=keelson_device,
    ).parsed


async def asyncio_detailed(
    code: str,
    *,
    client: AuthenticatedClient,
    body: ConnectionDraft,
    keelson_device: str | Unset = UNSET,
) -> Response[DraftConnectionMandateResponse200 | Problem]:
    """Draft the mandate that approves a request

     The unsigned mandate for the limits the user chose, which may only be lower than or equal to what
    the agent asked. It names the asking agent's operator. Sign it and store it with `POST
    /v1/mandates`, passing `connection`, to approve.

    Args:
        code (str):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DraftConnectionMandateResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        code=code,
        body=body,
        keelson_device=keelson_device,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    code: str,
    *,
    client: AuthenticatedClient,
    body: ConnectionDraft,
    keelson_device: str | Unset = UNSET,
) -> DraftConnectionMandateResponse200 | Problem | None:
    """Draft the mandate that approves a request

     The unsigned mandate for the limits the user chose, which may only be lower than or equal to what
    the agent asked. It names the asking agent's operator. Sign it and store it with `POST
    /v1/mandates`, passing `connection`, to approve.

    Args:
        code (str):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DraftConnectionMandateResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            code=code,
            client=client,
            body=body,
            keelson_device=keelson_device,
        )
    ).parsed

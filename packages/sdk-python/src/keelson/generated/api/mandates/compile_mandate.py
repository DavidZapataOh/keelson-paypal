from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.compile_mandate import CompileMandate
from ...models.compiled_mandate import CompiledMandate
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: CompileMandate,
    keelson_device: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(keelson_device, Unset):
        headers["keelson-device"] = keelson_device

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/mandates/compile",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> CompiledMandate | Problem | None:
    if response.status_code == 200:
        response_200 = CompiledMandate.from_dict(response.json())

        return response_200

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
) -> Response[CompiledMandate | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: CompileMandate,
    keelson_device: str | Unset = UNSET,
) -> Response[CompiledMandate | Problem]:
    """Compile a mandate from a shopping request

     Two models compile the request independently; fields they disagree on or the request leaves unstated
    come back ambiguous, and a third model checks the rendered card against the request. Limited to 10
    requests a minute per user.

    Args:
        keelson_device (str | Unset): The app's opaque device id, recorded as
            `risk_data.device_fp`. Required.
        body (CompileMandate):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CompiledMandate | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
        keelson_device=keelson_device,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient,
    body: CompileMandate,
    keelson_device: str | Unset = UNSET,
) -> CompiledMandate | Problem | None:
    """Compile a mandate from a shopping request

     Two models compile the request independently; fields they disagree on or the request leaves unstated
    come back ambiguous, and a third model checks the rendered card against the request. Limited to 10
    requests a minute per user.

    Args:
        keelson_device (str | Unset): The app's opaque device id, recorded as
            `risk_data.device_fp`. Required.
        body (CompileMandate):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CompiledMandate | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
        keelson_device=keelson_device,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: CompileMandate,
    keelson_device: str | Unset = UNSET,
) -> Response[CompiledMandate | Problem]:
    """Compile a mandate from a shopping request

     Two models compile the request independently; fields they disagree on or the request leaves unstated
    come back ambiguous, and a third model checks the rendered card against the request. Limited to 10
    requests a minute per user.

    Args:
        keelson_device (str | Unset): The app's opaque device id, recorded as
            `risk_data.device_fp`. Required.
        body (CompileMandate):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CompiledMandate | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
        keelson_device=keelson_device,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: CompileMandate,
    keelson_device: str | Unset = UNSET,
) -> CompiledMandate | Problem | None:
    """Compile a mandate from a shopping request

     Two models compile the request independently; fields they disagree on or the request leaves unstated
    come back ambiguous, and a third model checks the rendered card against the request. Limited to 10
    requests a minute per user.

    Args:
        keelson_device (str | Unset): The app's opaque device id, recorded as
            `risk_data.device_fp`. Required.
        body (CompileMandate):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CompiledMandate | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            keelson_device=keelson_device,
        )
    ).parsed

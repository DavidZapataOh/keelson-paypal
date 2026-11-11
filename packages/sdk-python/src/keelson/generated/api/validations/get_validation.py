from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.validation_request import ValidationRequest
from ...types import Response


def _get_kwargs(
    request_hash: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/validations/{request_hash}".format(
            request_hash=quote(str(request_hash), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | ValidationRequest | None:
    if response.status_code == 200:
        response_200 = ValidationRequest.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | ValidationRequest]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    request_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Problem | ValidationRequest]:
    """Validation request of a countersign

     What the `requestURI` of a Keelson validation request points to: the countersign whose EIP-712
    digest, under the VerdictVerifier domain, is `requestHash`.

    Args:
        request_hash (str): The countersign digest, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | ValidationRequest]
    """

    kwargs = _get_kwargs(
        request_hash=request_hash,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    request_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> Problem | ValidationRequest | None:
    """Validation request of a countersign

     What the `requestURI` of a Keelson validation request points to: the countersign whose EIP-712
    digest, under the VerdictVerifier domain, is `requestHash`.

    Args:
        request_hash (str): The countersign digest, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | ValidationRequest
    """

    return sync_detailed(
        request_hash=request_hash,
        client=client,
    ).parsed


async def asyncio_detailed(
    request_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Problem | ValidationRequest]:
    """Validation request of a countersign

     What the `requestURI` of a Keelson validation request points to: the countersign whose EIP-712
    digest, under the VerdictVerifier domain, is `requestHash`.

    Args:
        request_hash (str): The countersign digest, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | ValidationRequest]
    """

    kwargs = _get_kwargs(
        request_hash=request_hash,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    request_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> Problem | ValidationRequest | None:
    """Validation request of a countersign

     What the `requestURI` of a Keelson validation request points to: the countersign whose EIP-712
    digest, under the VerdictVerifier domain, is `requestHash`.

    Args:
        request_hash (str): The countersign digest, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | ValidationRequest
    """

    return (
        await asyncio_detailed(
            request_hash=request_hash,
            client=client,
        )
    ).parsed

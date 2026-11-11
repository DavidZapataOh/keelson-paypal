from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.web_fact import WebFact
from ...models.web_fact_request import WebFactRequest
from ...types import Response


def _get_kwargs(
    *,
    body: WebFactRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/observations/web-fact",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | WebFact | None:
    if response.status_code == 201:
        response_201 = WebFact.from_dict(response.json())

        return response_201

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
) -> Response[Problem | WebFact]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: WebFactRequest,
) -> Response[Problem | WebFact]:
    """Notarize a product endpoint with TLSNotary

     Fetches the endpoint once over TLS with leg A as the TLSNotary notary (MPC-TLS, or Proxy-TLS when
    MPC-TLS fails), commits to the body or to the object around `anchor`, and returns the EIP-712
    `WebFact` leg A signed with its attested key. Runs apart from any countersign and never delays one.
    An app acting for a user needs `evidence:write`.

    Args:
        body (WebFactRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | WebFact]
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
    body: WebFactRequest,
) -> Problem | WebFact | None:
    """Notarize a product endpoint with TLSNotary

     Fetches the endpoint once over TLS with leg A as the TLSNotary notary (MPC-TLS, or Proxy-TLS when
    MPC-TLS fails), commits to the body or to the object around `anchor`, and returns the EIP-712
    `WebFact` leg A signed with its attested key. Runs apart from any countersign and never delays one.
    An app acting for a user needs `evidence:write`.

    Args:
        body (WebFactRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | WebFact
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: WebFactRequest,
) -> Response[Problem | WebFact]:
    """Notarize a product endpoint with TLSNotary

     Fetches the endpoint once over TLS with leg A as the TLSNotary notary (MPC-TLS, or Proxy-TLS when
    MPC-TLS fails), commits to the body or to the object around `anchor`, and returns the EIP-712
    `WebFact` leg A signed with its attested key. Runs apart from any countersign and never delays one.
    An app acting for a user needs `evidence:write`.

    Args:
        body (WebFactRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | WebFact]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: WebFactRequest,
) -> Problem | WebFact | None:
    """Notarize a product endpoint with TLSNotary

     Fetches the endpoint once over TLS with leg A as the TLSNotary notary (MPC-TLS, or Proxy-TLS when
    MPC-TLS fails), commits to the body or to the object around `anchor`, and returns the EIP-712
    `WebFact` leg A signed with its attested key. Runs apart from any countersign and never delays one.
    An app acting for a user needs `evidence:write`.

    Args:
        body (WebFactRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | WebFact
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed

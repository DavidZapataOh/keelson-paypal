from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.feedback import Feedback
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    coverage_id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/feedback/{coverage_id}".format(
            coverage_id=quote(str(coverage_id), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Feedback | Problem | None:
    if response.status_code == 200:
        response_200 = Feedback.from_dict(response.json())

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
) -> Response[Feedback | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    coverage_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Feedback | Problem]:
    """Feedback file of a rated coverage

     The off-chain feedback file the `feedbackURI` of Keelson's ERC-8004 feedback points to, built from
    the reporter's `CoverageRated` log and the Reputation registry's `NewFeedback` log of the same
    transaction.

    Args:
        coverage_id (str): The coverage id, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Feedback | Problem]
    """

    kwargs = _get_kwargs(
        coverage_id=coverage_id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    coverage_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Feedback | Problem | None:
    """Feedback file of a rated coverage

     The off-chain feedback file the `feedbackURI` of Keelson's ERC-8004 feedback points to, built from
    the reporter's `CoverageRated` log and the Reputation registry's `NewFeedback` log of the same
    transaction.

    Args:
        coverage_id (str): The coverage id, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Feedback | Problem
    """

    return sync_detailed(
        coverage_id=coverage_id,
        client=client,
    ).parsed


async def asyncio_detailed(
    coverage_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Feedback | Problem]:
    """Feedback file of a rated coverage

     The off-chain feedback file the `feedbackURI` of Keelson's ERC-8004 feedback points to, built from
    the reporter's `CoverageRated` log and the Reputation registry's `NewFeedback` log of the same
    transaction.

    Args:
        coverage_id (str): The coverage id, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Feedback | Problem]
    """

    kwargs = _get_kwargs(
        coverage_id=coverage_id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    coverage_id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Feedback | Problem | None:
    """Feedback file of a rated coverage

     The off-chain feedback file the `feedbackURI` of Keelson's ERC-8004 feedback points to, built from
    the reporter's `CoverageRated` log and the Reputation registry's `NewFeedback` log of the same
    transaction.

    Args:
        coverage_id (str): The coverage id, 32 bytes of lowercase hex.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Feedback | Problem
    """

    return (
        await asyncio_detailed(
            coverage_id=coverage_id,
            client=client,
        )
    ).parsed

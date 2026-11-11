from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.mandate_change_request import MandateChangeRequest
from ...models.problem import Problem
from ...models.request_mandate_change_response_201 import RequestMandateChangeResponse201
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: MandateChangeRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/mandates/{id}/changes".format(
            id=quote(str(id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | RequestMandateChangeResponse201 | None:
    if response.status_code == 201:
        response_201 = RequestMandateChangeResponse201.from_dict(response.json())

        return response_201

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | RequestMandateChangeResponse201]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
    body: MandateChangeRequest,
) -> Response[Problem | RequestMandateChangeResponse201]:
    """Ask the user to change a mandate

     The agent asks its user for different limits, with a one-line note the user reads verbatim. The user
    may lower what is asked and approves with a passkey; the new mandate then replaces this one, whose
    hold is released. Nothing changes until the user signs. Poll `GET /v1/connections/requests/{id}` for
    the answer. An app acting for a user (`mandates:request`) asks only about a mandate that user
    approved for it.

    Args:
        id (str):
        body (MandateChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | RequestMandateChangeResponse201]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: AuthenticatedClient,
    body: MandateChangeRequest,
) -> Problem | RequestMandateChangeResponse201 | None:
    """Ask the user to change a mandate

     The agent asks its user for different limits, with a one-line note the user reads verbatim. The user
    may lower what is asked and approves with a passkey; the new mandate then replaces this one, whose
    hold is released. Nothing changes until the user signs. Poll `GET /v1/connections/requests/{id}` for
    the answer. An app acting for a user (`mandates:request`) asks only about a mandate that user
    approved for it.

    Args:
        id (str):
        body (MandateChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | RequestMandateChangeResponse201
    """

    return sync_detailed(
        id=id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
    body: MandateChangeRequest,
) -> Response[Problem | RequestMandateChangeResponse201]:
    """Ask the user to change a mandate

     The agent asks its user for different limits, with a one-line note the user reads verbatim. The user
    may lower what is asked and approves with a passkey; the new mandate then replaces this one, whose
    hold is released. Nothing changes until the user signs. Poll `GET /v1/connections/requests/{id}` for
    the answer. An app acting for a user (`mandates:request`) asks only about a mandate that user
    approved for it.

    Args:
        id (str):
        body (MandateChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | RequestMandateChangeResponse201]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: AuthenticatedClient,
    body: MandateChangeRequest,
) -> Problem | RequestMandateChangeResponse201 | None:
    """Ask the user to change a mandate

     The agent asks its user for different limits, with a one-line note the user reads verbatim. The user
    may lower what is asked and approves with a passkey; the new mandate then replaces this one, whose
    hold is released. Nothing changes until the user signs. Poll `GET /v1/connections/requests/{id}` for
    the answer. An app acting for a user (`mandates:request`) asks only about a mandate that user
    approved for it.

    Args:
        id (str):
        body (MandateChangeRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | RequestMandateChangeResponse201
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed

from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.list_tee_attestations_response_200 import ListTeeAttestationsResponse200
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/tee/attestations",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> ListTeeAttestationsResponse200 | None:
    if response.status_code == 200:
        response_200 = ListTeeAttestationsResponse200.from_dict(response.json())

        return response_200

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[ListTeeAttestationsResponse200]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[ListTeeAttestationsResponse200]:
    """Attested TEE signers

     The signers whose countersignatures are accepted, each with the attestation it was admitted from,
    and the measurements the deployment publishes. A verifier checks the attestations itself.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ListTeeAttestationsResponse200]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
) -> ListTeeAttestationsResponse200 | None:
    """Attested TEE signers

     The signers whose countersignatures are accepted, each with the attestation it was admitted from,
    and the measurements the deployment publishes. A verifier checks the attestations itself.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ListTeeAttestationsResponse200
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[ListTeeAttestationsResponse200]:
    """Attested TEE signers

     The signers whose countersignatures are accepted, each with the attestation it was admitted from,
    and the measurements the deployment publishes. A verifier checks the attestations itself.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[ListTeeAttestationsResponse200]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
) -> ListTeeAttestationsResponse200 | None:
    """Attested TEE signers

     The signers whose countersignatures are accepted, each with the attestation it was admitted from,
    and the measurements the deployment publishes. A verifier checks the attestations itself.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        ListTeeAttestationsResponse200
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed

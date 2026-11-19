---
title: Single sign-on for a workspace
description: Connect a workspace to your organisation's identity provider with OpenID Connect or SAML, verify your email domains and provision members with SCIM.
category: workspace-admin
order: 2
updated: '2026-11-09'
---

# Single sign-on for a workspace

> **Availability.** On markoto.app single sign-on is part of the **Business**
> plan (coming soon). On a self-hosted instance every workspace can use it;
> the operator only needs to set the instance's public address (see the [self-hosting guide](https://github.com/markoto-app/markoto/blob/main/docs/SELF-HOSTING.md)).

With single sign-on, the members of a workspace sign in through your
organisation's identity provider, such as Microsoft Entra ID, Okta, Google
Workspace or Keycloak. Your IT team then decides who gets in, and removing
someone there removes their access to the workspace.

Workspace admins set it up under the workspace's **Single sign-on** tab.

::flow{id="set-up-single-sign-on-for-a-workspace" hide-title}
::

## 1. Connect your identity provider

Choose **OpenID Connect** or **SAML**.

- **OpenID Connect:** create an application ("web app", authorisation-code
  flow) at your provider and enter its issuer URL, client ID and client
  secret. Give the provider the **Redirect URI** markoto shows.
- **SAML:** enter your provider's entity ID, its single sign-on URL and its
  signing certificate. Give the provider markoto's **Entity ID** and
  **Reply URL (ACS)**, or let it read the **Metadata URL**. markoto only
  accepts sign-ins it started itself and requires a signed assertion.

The client secret is stored encrypted and never shown again. The
certificate is shown only by its name and expiry date.

## 2. Verify your email domains

Add the domains your organisation's addresses use, for example
`example.com`, and publish the TXT record markoto shows in that domain's
DNS. Press **Check now** once it is published; DNS changes can take up to an
hour.

Only addresses in a verified domain are:

- linked to an existing markoto account with the same address, so people
  keep their documents, and
- added to the workspace on their first sign-in (with the **role for new
  members**), as long as a seat is free.

Public mail domains such as gmail.com can't be verified, and a domain can
belong to one workspace only.

## 3. Test and switch on

Press **Test sign-in and switch on**. You sign in at your provider with your
own account; when that works, single sign-on is **on** for the workspace.

From then on, everyone opens the workspace only after signing in through
your provider. A sign-in counts for 12 hours and ends with "Log out
everywhere". Members who open the workspace without one see a
**Sign in with your organisation** button. On the sign-in screen, people can
also type their work email to go straight to your provider.

Changing the provider settings switches single sign-on off again until the
next successful test, so a typo can't lock everyone out. Switching to another
provider also ends everyone's sign-ins: they sign in again through the new
one. Admins can always
reach the Single sign-on settings, even without signing in through the
provider, to fix or remove the connection.

Removing someone from the workspace ends their access at once. If their
email is in one of your verified domains, they can join again by signing in
through your provider, so remove them there as well.

Documents in the workspace that are shared with **anyone who has the link**
stay reachable by link: the link setting applies to everyone, member or
not.

## 4. Provision members automatically (SCIM)

Under **Provisioning (SCIM)**, create a token and enter it with the
**SCIM base URL** in your provider's provisioning settings. The token is
shown once; replacing it stops the old one at once.

- People your provider assigns to markoto are added to the workspace
  (their address must be in a verified domain).
- Deactivating someone there removes them from the workspace at once and
  blocks their sign-in until they are reactivated.
- Removing someone there removes them from the workspace; their markoto
  account itself stays, since it may hold their own documents.
- Roles are managed in markoto. The workspace's last admin can't be
  removed through provisioning.
- Names and email addresses belong to the person's markoto account. A
  change sent by your provider is accepted but not applied; the answer
  shows the name markoto has. People change their own name in markoto.
- Only users are provisioned. Requests for groups get a "not supported"
  answer, which providers handle on their own.

## Removing single sign-on

**Remove single sign-on** ends it at once. Members sign in as before, with
GitHub, Google or your instance's sign-in.

## What's next

- [Team and Business for a workspace](/docs/plans/team-plan): seats and the shared AI budget.
- [Sessions and signing out](/docs/account/sessions): "Log out everywhere".

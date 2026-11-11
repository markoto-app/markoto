<script setup lang="ts">
// Single sign-on settings of a workspace: the identity provider
// (OpenID Connect or SAML), the values to enter at the IdP, the test
// sign-in that switches it on, verified email domains, SCIM provisioning
// and removal. Admins only; works without a current SSO sign-in (the
// break-glass), so it is also shown on the "sign in with your
// organisation" screen. Server: `server/api/workspaces/[wsId]/sso/`.

interface DomainView { id: number, domain: string, verified: boolean, txtName: string, txtValue: string }
interface SsoView {
  available: boolean
  connection: null | {
    id: string
    protocol: 'oidc' | 'saml'
    status: 'draft' | 'active'
    defaultRole: 'editor' | 'viewer'
    oidcIssuer: string | null
    oidcClientId: string | null
    hasClientSecret: boolean
    samlIdpEntityId: string | null
    samlSsoUrl: string | null
    samlCertificate: null | { subject: string, validTo: string }
    hasScimToken: boolean
    activatedAt: string | null
    sp: { loginUrl: string, callbackUrl: string, entityId: string, acsUrl: string, metadataUrl: string, scimBaseUrl: string }
  }
  domains: DomainView[]
}

const props = defineProps<{ workspaceId: string }>()
const emit = defineEmits<{ changed: [] }>()

const { t, d } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()
const { copy } = useClipboard()

const view = ref<SsoView | null>(null)
// The template reads `cur` inside `v-else-if="view"`: Vue's type check
// loses that narrowing in nested blocks and handlers.
const EMPTY_VIEW: SsoView = { available: false, connection: null, domains: [] }
const cur = computed<SsoView>(() => view.value ?? EMPTY_VIEW)
const loading = ref(true)
const busy = ref<string | null>(null)
const base = computed(() => `/api/workspaces/${encodeURIComponent(props.workspaceId)}/sso`)

const protocol = ref<'oidc' | 'saml'>('oidc')
const oidcIssuer = ref('')
const oidcClientId = ref('')
const oidcClientSecret = ref('')
const samlIdpEntityId = ref('')
const samlSsoUrl = ref('')
const samlIdpCert = ref('')
const defaultRole = ref<'editor' | 'viewer'>('editor')
const newDomain = ref('')
const scimToken = ref<string | null>(null)
const confirmRemove = ref(false)

function seedForm(v: SsoView): void {
  const c = v.connection
  protocol.value = c?.protocol ?? 'oidc'
  oidcIssuer.value = c?.oidcIssuer ?? ''
  oidcClientId.value = c?.oidcClientId ?? ''
  oidcClientSecret.value = ''
  samlIdpEntityId.value = c?.samlIdpEntityId ?? ''
  samlSsoUrl.value = c?.samlSsoUrl ?? ''
  samlIdpCert.value = ''
  defaultRole.value = c?.defaultRole ?? 'editor'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    view.value = await $fetch<SsoView>(base.value)
    seedForm(view.value)
  } catch (e) {
    showError('sso.loadFailed', e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

const protocolItems = computed(() => [
  { label: t('sso.protocol.oidc'), value: 'oidc' },
  { label: t('sso.protocol.saml'), value: 'saml' }
])
const roleItems = computed(() => [
  { label: t('workspace.roles.editor'), value: 'editor' },
  { label: t('workspace.roles.viewer'), value: 'viewer' }
])

async function save(): Promise<void> {
  busy.value = 'save'
  try {
    const body = protocol.value === 'oidc'
      ? { protocol: 'oidc', oidcIssuer: oidcIssuer.value, oidcClientId: oidcClientId.value, ...(oidcClientSecret.value ? { oidcClientSecret: oidcClientSecret.value } : {}), defaultRole: defaultRole.value }
      : { protocol: 'saml', samlIdpEntityId: samlIdpEntityId.value, samlSsoUrl: samlSsoUrl.value, samlIdpCert: samlIdpCert.value || undefined, defaultRole: defaultRole.value }
    view.value = await $fetch<SsoView>(base.value, { method: 'PUT', body })
    seedForm(view.value)
    toast.add({ title: t('sso.saved'), icon: 'i-lucide-check', color: 'neutral' })
    emit('changed')
  } catch (e) {
    showError('sso.saveFailed', e)
  } finally {
    busy.value = null
  }
}

function testSignIn(): void {
  if (!view.value?.connection) return
  globalThis.location.href = `/auth/sso/${encodeURIComponent(view.value.connection.id)}?test=1`
}

async function addDomain(): Promise<void> {
  if (!newDomain.value.trim()) return
  busy.value = 'domain'
  try {
    const row = await $fetch<DomainView>(`${base.value}/domains`, { method: 'POST', body: { domain: newDomain.value } })
    view.value?.domains.push(row)
    newDomain.value = ''
  } catch (e) {
    showError('sso.domainAddFailed', e)
  } finally {
    busy.value = null
  }
}

async function verifyDomain(domain: DomainView): Promise<void> {
  busy.value = `verify-${domain.id}`
  try {
    const row = await $fetch<DomainView>(`${base.value}/domains/${domain.id}/verify`, { method: 'POST' })
    Object.assign(domain, row)
    toast.add({ title: t('sso.domainVerified', { domain: domain.domain }), icon: 'i-lucide-check', color: 'neutral' })
  } catch (e) {
    showError('sso.domainVerifyFailed', e)
  } finally {
    busy.value = null
  }
}

async function removeDomain(domain: DomainView): Promise<void> {
  busy.value = `remove-${domain.id}`
  try {
    await $fetch(`${base.value}/domains/${domain.id}`, { method: 'DELETE' })
    if (view.value) view.value.domains = view.value.domains.filter(x => x.id !== domain.id)
  } catch (e) {
    showError('sso.domainRemoveFailed', e)
  } finally {
    busy.value = null
  }
}

async function createScimToken(): Promise<void> {
  busy.value = 'scim'
  try {
    const res = await $fetch<{ token: string }>(`${base.value}/scim-token`, { method: 'POST' })
    scimToken.value = res.token
    if (view.value?.connection) view.value.connection.hasScimToken = true
  } catch (e) {
    showError('sso.scimFailed', e)
  } finally {
    busy.value = null
  }
}

async function revokeScimToken(): Promise<void> {
  busy.value = 'scim'
  try {
    await $fetch(`${base.value}/scim-token`, { method: 'DELETE' })
    scimToken.value = null
    if (view.value?.connection) view.value.connection.hasScimToken = false
  } catch (e) {
    showError('sso.scimFailed', e)
  } finally {
    busy.value = null
  }
}

async function removeConnection(): Promise<void> {
  busy.value = 'remove'
  try {
    await $fetch(base.value, { method: 'DELETE' })
    confirmRemove.value = false
    await load()
    toast.add({ title: t('sso.removed'), icon: 'i-lucide-check', color: 'neutral' })
    emit('changed')
  } catch (e) {
    showError('sso.removeFailed', e)
  } finally {
    busy.value = null
  }
}

function copyValue(value: string): void {
  copy(value)
  toast.add({ title: t('sso.copied'), icon: 'i-lucide-copy', color: 'neutral' })
}

const spRows = computed(() => {
  const c = view.value?.connection
  if (!c) return []
  return c.protocol === 'oidc'
    ? [{ key: 'callback', label: t('sso.sp.callbackUrl'), value: c.sp.callbackUrl }]
    : [
        { key: 'entity', label: t('sso.sp.entityId'), value: c.sp.entityId },
        { key: 'acs', label: t('sso.sp.acsUrl'), value: c.sp.acsUrl },
        { key: 'metadata', label: t('sso.sp.metadataUrl'), value: c.sp.metadataUrl }
      ]
})
</script>

<template>
  <section
    class="space-y-6"
    data-testid="workspace-sso-panel"
  >
    <div class="flex items-center gap-2.5">
      <UIcon
        name="i-lucide-key-round"
        class="text-toned size-5 shrink-0"
      />
      <h2 class="font-serif text-2xl font-normal tracking-tight">
        {{ t('sso.title') }}
      </h2>
      <UBadge
        v-if="view?.connection"
        :label="view.connection.status === 'active' ? t('sso.status.active') : t('sso.status.draft')"
        :variant="view.connection.status === 'active' ? 'solid' : 'outline'"
        color="neutral"
        size="sm"
        data-testid="workspace-sso-status"
      />
    </div>

    <p
      v-if="loading"
      class="text-sm text-muted"
    >
      {{ t('sso.loading') }}
    </p>

    <template v-else-if="view">
      <CommonPlanLimitNotice
        v-if="!cur.available"
        message-key="sso.planNotice"
        data-testid="workspace-sso-plan-notice"
      />

      <p class="text-sm text-muted max-w-2xl">
        {{ t('sso.intro') }}
      </p>

      <UAlert
        v-if="cur.connection?.status === 'active'"
        color="neutral"
        variant="subtle"
        icon="i-lucide-shield-check"
        :description="t('sso.enforcedNotice')"
        data-testid="workspace-sso-enforced"
      />

      <div
        v-if="cur.available || cur.connection"
        class="rounded-lg border border-default bg-default p-5 space-y-5"
      >
        <h3 class="font-serif text-lg font-normal tracking-tight">
          {{ t('sso.idpTitle') }}
        </h3>
        <UTabs
          v-model="protocol"
          :items="protocolItems"
          :content="false"
          color="neutral"
          size="sm"
          class="max-w-sm"
          data-testid="workspace-sso-protocol"
        />
        <div
          v-if="protocol === 'oidc'"
          class="grid gap-4 sm:grid-cols-2"
        >
          <UFormField
            :label="t('sso.oidc.issuer')"
            :hint="t('sso.oidc.issuerHint')"
            class="sm:col-span-2"
          >
            <UInput
              v-model="oidcIssuer"
              placeholder="https://login.example.com/realms/acme"
              class="w-full"
              data-testid="workspace-sso-oidc-issuer"
            />
          </UFormField>
          <UFormField :label="t('sso.oidc.clientId')">
            <UInput
              v-model="oidcClientId"
              class="w-full"
              data-testid="workspace-sso-oidc-client-id"
            />
          </UFormField>
          <UFormField
            :label="t('sso.oidc.clientSecret')"
            :hint="cur.connection?.hasClientSecret ? t('sso.oidc.secretKept') : undefined"
          >
            <UInput
              v-model="oidcClientSecret"
              type="password"
              autocomplete="off"
              class="w-full"
              data-testid="workspace-sso-oidc-client-secret"
            />
          </UFormField>
        </div>
        <div
          v-else
          class="grid gap-4"
        >
          <UFormField :label="t('sso.saml.entityId')">
            <UInput
              v-model="samlIdpEntityId"
              class="w-full"
              data-testid="workspace-sso-saml-entity-id"
            />
          </UFormField>
          <UFormField :label="t('sso.saml.ssoUrl')">
            <UInput
              v-model="samlSsoUrl"
              placeholder="https://idp.example.com/saml/sso"
              class="w-full"
              data-testid="workspace-sso-saml-sso-url"
            />
          </UFormField>
          <UFormField
            :label="t('sso.saml.certificate')"
            :hint="cur.connection?.samlCertificate ? t('sso.saml.certificateKept', { subject: cur.connection.samlCertificate.subject, date: d(new Date(cur.connection.samlCertificate.validTo)) }) : undefined"
          >
            <UTextarea
              v-model="samlIdpCert"
              :rows="5"
              placeholder="-----BEGIN CERTIFICATE-----"
              class="w-full font-mono text-xs"
              data-testid="workspace-sso-saml-cert"
            />
          </UFormField>
        </div>
        <UFormField
          :label="t('sso.defaultRole')"
          :hint="t('sso.defaultRoleHint')"
        >
          <USelect
            v-model="defaultRole"
            :items="roleItems"
            class="w-48"
            data-testid="workspace-sso-default-role"
          />
        </UFormField>
        <div class="flex gap-2 flex-wrap">
          <UButton
            color="neutral"
            :loading="busy === 'save'"
            :disabled="!cur.available"
            data-testid="workspace-sso-save"
            @click="save"
          >
            {{ t('sso.save') }}
          </UButton>
          <UButton
            v-if="cur.connection"
            color="neutral"
            variant="outline"
            icon="i-lucide-log-in"
            data-testid="workspace-sso-test"
            @click="testSignIn"
          >
            {{ cur.connection.status === 'active' ? t('sso.testAgain') : t('sso.testAndActivate') }}
          </UButton>
        </div>
        <p
          v-if="cur.connection?.status === 'draft'"
          class="text-xs text-muted"
        >
          {{ t('sso.draftHint') }}
        </p>
      </div>

      <div
        v-if="cur.connection"
        class="rounded-lg border border-default bg-default p-5 space-y-3"
        data-testid="workspace-sso-sp"
      >
        <h3 class="font-serif text-lg font-normal tracking-tight">
          {{ t('sso.sp.title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('sso.sp.body') }}
        </p>
        <div
          v-for="row in [...spRows, { key: 'login', label: t('sso.sp.loginUrl'), value: cur.connection.sp.loginUrl }]"
          :key="row.key"
          class="flex items-center gap-2 flex-wrap"
        >
          <span class="text-sm w-40 shrink-0">{{ row.label }}</span>
          <code
            class="font-mono text-xs bg-muted rounded px-2 py-1 break-all flex-1 min-w-0"
            :data-testid="`workspace-sso-sp-${row.key}`"
          >{{ row.value }}</code>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-copy"
            :aria-label="t('sso.copy')"
            @click="copyValue(row.value)"
          />
        </div>
      </div>

      <div
        v-if="cur.available || cur.domains.length"
        class="rounded-lg border border-default bg-default p-5 space-y-4"
        data-testid="workspace-sso-domains"
      >
        <div class="space-y-1">
          <h3 class="font-serif text-lg font-normal tracking-tight">
            {{ t('sso.domains.title') }}
          </h3>
          <p class="text-sm text-muted">
            {{ t('sso.domains.body') }}
          </p>
        </div>
        <ul class="space-y-3">
          <li
            v-for="domain in cur.domains"
            :key="domain.id"
            class="space-y-1"
            :data-testid="`workspace-sso-domain-${domain.domain}`"
          >
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm">{{ domain.domain }}</span>
              <UBadge
                :label="domain.verified ? t('sso.domains.verified') : t('sso.domains.unverified')"
                :variant="domain.verified ? 'solid' : 'outline'"
                color="neutral"
                size="xs"
              />
              <UButton
                v-if="!domain.verified"
                size="xs"
                color="neutral"
                variant="outline"
                :loading="busy === `verify-${domain.id}`"
                :data-testid="`workspace-sso-domain-verify-${domain.domain}`"
                @click="verifyDomain(domain)"
              >
                {{ t('sso.domains.verify') }}
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="t('sso.domains.remove')"
                :loading="busy === `remove-${domain.id}`"
                @click="removeDomain(domain)"
              />
            </div>
            <p
              v-if="!domain.verified"
              class="text-xs text-muted"
            >
              {{ t('sso.domains.txtHint', { name: domain.txtName }) }}
              <code class="font-mono bg-muted rounded px-1 break-all">{{ domain.txtValue }}</code>
            </p>
          </li>
        </ul>
        <div
          v-if="cur.available"
          class="flex gap-2"
        >
          <UInput
            v-model="newDomain"
            placeholder="example.com"
            class="w-64"
            data-testid="workspace-sso-domain-input"
            @keydown.enter="addDomain"
          />
          <UButton
            color="neutral"
            variant="outline"
            :loading="busy === 'domain'"
            data-testid="workspace-sso-domain-add"
            @click="addDomain"
          >
            {{ t('sso.domains.add') }}
          </UButton>
        </div>
      </div>

      <div
        v-if="cur.connection && cur.available"
        class="rounded-lg border border-default bg-default p-5 space-y-3"
        data-testid="workspace-sso-scim"
      >
        <h3 class="font-serif text-lg font-normal tracking-tight">
          {{ t('sso.scim.title') }}
        </h3>
        <p class="text-sm text-muted">
          {{ t('sso.scim.body') }}
        </p>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm w-40 shrink-0">{{ t('sso.scim.baseUrl') }}</span>
          <code class="font-mono text-xs bg-muted rounded px-2 py-1 break-all">{{ cur.connection.sp.scimBaseUrl }}</code>
        </div>
        <UAlert
          v-if="scimToken"
          color="neutral"
          variant="subtle"
          icon="i-lucide-key"
          :title="t('sso.scim.tokenOnce')"
          data-testid="workspace-sso-scim-token"
        >
          <template #description>
            <code class="font-mono text-xs break-all">{{ scimToken }}</code>
          </template>
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-copy"
              :label="t('sso.copy')"
              @click="copyValue(scimToken)"
            />
          </template>
        </UAlert>
        <div class="flex gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :loading="busy === 'scim'"
            data-testid="workspace-sso-scim-create"
            @click="createScimToken"
          >
            {{ cur.connection.hasScimToken ? t('sso.scim.rotate') : t('sso.scim.create') }}
          </UButton>
          <UButton
            v-if="cur.connection.hasScimToken"
            color="neutral"
            variant="ghost"
            :loading="busy === 'scim'"
            @click="revokeScimToken"
          >
            {{ t('sso.scim.revoke') }}
          </UButton>
        </div>
      </div>

      <div
        v-if="cur.connection"
        class="flex items-center gap-2"
      >
        <UButton
          v-if="!confirmRemove"
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          data-testid="workspace-sso-remove"
          @click="confirmRemove = true"
        >
          {{ t('sso.remove') }}
        </UButton>
        <template v-else>
          <span class="text-sm">{{ t('sso.removeConfirm') }}</span>
          <UButton
            color="error"
            variant="outline"
            size="sm"
            :loading="busy === 'remove'"
            data-testid="workspace-sso-remove-confirm"
            @click="removeConnection"
          >
            {{ t('sso.remove') }}
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            @click="confirmRemove = false"
          >
            {{ t('common.cancel') }}
          </UButton>
        </template>
      </div>
    </template>
  </section>
</template>

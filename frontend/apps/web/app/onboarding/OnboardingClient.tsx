'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { useEffect, useMemo, useState } from 'react';

import { Logo, Select } from '@petrobrain/ui';
import type { Role } from '@petrobrain/types';

import { AuthGate } from '../chat/components/AuthGate';
import { Combobox } from '@/lib/ui/Combobox';
import {
  COUNTRY_NAMES,
  JOB_TITLES,
  defaultTimezoneForCountry,
  timezonesForCountry,
} from '@/lib/onboarding/geo';
import { useChatStore } from '@/lib/chat/store';
import { useSettingsStore } from '@/lib/chat/settings';
import {
  addOnboardingAsset,
  completeOnboarding,
  createInvitation,
  getOnboardingOptions,
  getOnboardingStatus,
  saveCompany,
  saveIndividual,
  selectAccountType,
  type AccountType,
  type OnboardingOptions,
  type OnboardingStatus,
} from '@/lib/onboarding/api';

const INDIVIDUAL_STEPS = ['Your role', 'Focus areas', 'Use cases', 'Region', 'Done'];
const COMPANY_STEPS = ['Company profile', 'Focus', 'Jurisdiction', 'Assets', 'Invite team', 'Done'];

const EMPTY_OPTIONS: OnboardingOptions = {
  account_types: ['individual', 'company'],
  focus_areas: [],
  use_cases: [],
  regions: [],
  company_types: [],
  company_sizes: [],
  regulator_focus: [],
  asset_types: [],
  roles: [],
};

interface IndividualState {
  full_name: string;
  job_title: string;
  country: string;
  timezone: string;
  focus_areas: string[];
  use_cases: string[];
  preferred_jurisdiction: string;
}

interface CompanyState {
  company_name: string;
  company_website: string;
  company_email_domain: string;
  country_of_registration: string;
  primary_operating_country: string;
  company_type: string;
  company_size: string;
  focus_areas: string[];
  primary_jurisdiction: string;
  secondary_jurisdictions: string[];
  regulator_focus: string[];
}

const INITIAL_INDIVIDUAL: IndividualState = {
  full_name: '',
  job_title: '',
  country: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lagos',
  focus_areas: [],
  use_cases: [],
  preferred_jurisdiction: 'Nigeria',
};

const INITIAL_COMPANY: CompanyState = {
  company_name: '',
  company_website: '',
  company_email_domain: '',
  country_of_registration: '',
  primary_operating_country: '',
  company_type: '',
  company_size: '',
  focus_areas: [],
  primary_jurisdiction: 'Nigeria',
  secondary_jurisdictions: [],
  regulator_focus: [],
};

export function OnboardingClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editMode = searchParams.get('edit') === '1';
  const token = useChatStore((state) => state.token);
  const principal = useChatStore((state) => state.principal);
  const baseUrl = useChatStore((state) => state.apiBaseUrl);
  const callMeName = useSettingsStore((state) => state.callMeName);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [step, setStep] = useState(0);
  const [individual, setIndividual] = useState(INITIAL_INDIVIDUAL);
  const [company, setCompany] = useState(INITIAL_COMPANY);
  // Whether we already know the user's name (from signup or a saved answer),
  // decided once at load so the name field can't appear/disappear mid-typing.
  const [nameKnown, setNameKnown] = useState(false);
  const [asset, setAsset] = useState({ asset_name: '', asset_type: 'Field', country: '', notes: '' });
  const [invite, setInvite] = useState({ email: '', role: 'engineer' as Role, department: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const auth = useMemo(
    () => token ? { baseUrl, token } : null,
    [baseUrl, token],
  );

  useEffect(() => {
    if (!auth) return;
    let active = true;
    Promise.all([getOnboardingStatus(auth), getOnboardingOptions(auth)])
      .then(([nextStatus, nextOptions]) => {
        if (!active) return;
        setStatus(nextStatus);
        setOptions(nextOptions);
        const savedName = typeof nextStatus.answers.full_name === 'string'
          ? nextStatus.answers.full_name.trim()
          : '';
        setNameKnown(Boolean(savedName || callMeName.trim()));
        hydrateAnswers(nextStatus.answers, callMeName, setIndividual, setCompany);
        if (nextStatus.onboarding_status === 'completed' && !editMode) {
          router.replace('/chat');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load onboarding.');
      });
    return () => { active = false; };
  }, [auth, editMode, router, callMeName]);

  if (!token || !principal) return <AuthGate />;
  if (!status && !error) return <LoadingOnboarding />;
  if (error && !status) return <OnboardingError message={error} />;

  const accountType = status?.account_type;
  if (!accountType) {
    return (
      <OnboardingShell steps={['Account type']} current={0}>
        <h1 className="text-2xl font-semibold">Choose your workspace</h1>
        <p className="mt-2 text-sm text-neutral-500">You can configure optional details later.</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {(['individual', 'company'] as AccountType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => void chooseType(type)}
              className="rounded-2xl border border-neutral-200 p-5 text-left hover:border-primary-400 dark:border-neutral-800"
            >
              <strong className="capitalize">{type === 'company' ? 'Company / Organization' : type}</strong>
              <p className="mt-2 text-sm text-neutral-500">
                {type === 'individual' ? 'A private personal workspace.' : 'A governed workspace for a team.'}
              </p>
            </button>
          ))}
        </div>
      </OnboardingShell>
    );
  }

  const steps = accountType === 'individual' ? INDIVIDUAL_STEPS : COMPANY_STEPS;

  async function chooseType(type: AccountType) {
    if (!auth) return;
    setBusy(true);
    try {
      await selectAccountType(auth, type);
      setStatus((current) => current ? { ...current, account_type: type } : current);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    if (!auth || !accountType || busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (accountType === 'individual') {
        validateIndividual(individual, step);
        await saveIndividual(auth, { ...individual, current_step: INDIVIDUAL_STEPS[Math.min(step + 1, 4)] });
      } else if (step <= 2) {
        validateCompany(company, step);
        await saveCompany(auth, { ...company, current_step: COMPANY_STEPS[Math.min(step + 1, 5)] });
      }
      setStep((current) => Math.min(current + 1, steps.length - 1));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function finish(skippedOptional = false) {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      if (accountType === 'individual') {
        await saveIndividual(auth, { ...individual, current_step: 'done' });
      } else {
        await saveCompany(auth, { ...company, current_step: 'done' });
      }
      const result = await completeOnboarding(auth, skippedOptional);
      // Individuals always land in the chat workspace; only company accounts
      // follow the server's recommended destination (the admin console).
      const destination = accountType === 'individual' ? '/chat' : result.recommended_destination;
      router.replace(destination as Route);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function addAsset() {
    if (!auth || !asset.asset_name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addOnboardingAsset(auth, asset);
      setNotice(`${asset.asset_name} was added to the company workspace.`);
      setAsset((current) => ({ ...current, asset_name: '', notes: '' }));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function inviteTeammate() {
    if (!auth || !invite.email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createInvitation(auth, invite);
      const sharePath = result.invite_path
        ? ` Share this secure link: ${window.location.origin}${result.invite_path}`
        : '';
      setNotice(
        `${result.delivery?.message || 'Invite created inside PetroBrain.'}${sharePath}`,
      );
      setInvite((current) => ({ ...current, email: '', department: '' }));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <OnboardingShell steps={steps} current={step}>
      {accountType === 'individual' ? (
        <IndividualStep
          step={step}
          state={individual}
          options={options}
          nameKnown={nameKnown}
          onChange={setIndividual}
        />
      ) : (
        <CompanyStep
          step={step}
          state={company}
          options={options}
          asset={asset}
          invite={invite}
          onChange={setCompany}
          onAssetChange={setAsset}
          onInviteChange={setInvite}
          onAddAsset={() => void addAsset()}
          onInvite={() => void inviteTeammate()}
          busy={busy}
        />
      )}

      {notice ? <p role="status" className="mt-5 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200">{notice}</p> : null}
      {error ? <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</p> : null}

      <footer className="mt-8 flex items-center justify-between border-t border-neutral-200 pt-5 dark:border-neutral-800">
        <button
          type="button"
          disabled={step === 0 || busy}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          className="text-sm font-medium text-neutral-500 disabled:opacity-30"
        >
          Back
        </button>
        <div className="flex items-center gap-3">
          {accountType === 'company' && (step === 3 || step === 4) ? (
            <button type="button" disabled={busy} onClick={() => setStep((current) => current + 1)} className="text-sm font-medium text-neutral-500">
              Skip for now
            </button>
          ) : null}
          {step === steps.length - 1 ? (
            <button type="button" disabled={busy} onClick={() => void finish()} className="rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? 'Preparing workspace...' : 'Enter PetroBrain'}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void next()} className="rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? 'Saving...' : 'Save and continue'}
            </button>
          )}
        </div>
      </footer>
    </OnboardingShell>
  );
}

function IndividualStep({
  step,
  state,
  options,
  nameKnown,
  onChange,
}: {
  step: number;
  state: IndividualState;
  options: OnboardingOptions;
  nameKnown: boolean;
  onChange: (state: IndividualState) => void;
}) {
  if (step === 0) {
    return (
      <Step
        title={nameKnown && state.full_name.trim() ? `Welcome, ${state.full_name.trim()}` : 'Tell us about your work'}
        subtitle="Tell us where you work so PetroBrain can tune its defaults."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {nameKnown ? null : (
            <TextField label="Full name" value={state.full_name} onChange={(full_name) => onChange({ ...state, full_name })} />
          )}
          <Combobox
            label="Job title or role"
            value={state.job_title}
            options={JOB_TITLES}
            onChange={(job_title) => onChange({ ...state, job_title })}
            searchable
            allowOther
            placeholder="Select your role"
            otherPlaceholder="Enter your job title"
          />
          <Combobox
            label="Country"
            value={state.country}
            options={COUNTRY_NAMES}
            onChange={(country) =>
              onChange({
                ...state,
                country,
                // Auto-fill the timezone only for a recognized country; a typed
                // "Other" country leaves whatever timezone the user has set.
                ...(COUNTRY_NAMES.includes(country)
                  ? { timezone: defaultTimezoneForCountry(country) }
                  : {}),
              })
            }
            searchable
            allowOther
            placeholder="Select your country"
            otherPlaceholder="Enter your country"
          />
          <Combobox
            label="Timezone"
            value={state.timezone}
            options={timezonesForCountry(state.country)}
            onChange={(timezone) => onChange({ ...state, timezone })}
            searchable
            allowOther
            placeholder="Select your timezone"
            otherPlaceholder="Enter your timezone"
          />
        </div>
      </Step>
    );
  }
  if (step === 1) {
    return <ChoiceStep title="What area of oil and gas do you work with most?" options={options.focus_areas} selected={state.focus_areas} onChange={(focus_areas) => onChange({ ...state, focus_areas })} />;
  }
  if (step === 2) {
    return <ChoiceStep title="What do you want PetroBrain to help you with?" options={options.use_cases} selected={state.use_cases} onChange={(use_cases) => onChange({ ...state, use_cases })} />;
  }
  if (step === 3) {
    return (
      <Step title="Which region should PetroBrain prioritize?" subtitle="This tunes source and regulatory suggestions; you can change it later.">
        <Combobox
          label="Preferred jurisdiction"
          value={state.preferred_jurisdiction}
          options={options.regions}
          onChange={(preferred_jurisdiction) => onChange({ ...state, preferred_jurisdiction })}
          allowOther
          placeholder="Select a region"
          otherPlaceholder="Enter your jurisdiction"
        />
      </Step>
    );
  }
  return <Ready title="Your PetroBrain workspace is ready." body="Your research, document, safety, and technical defaults have been personalized." />;
}

function CompanyStep({
  step,
  state,
  options,
  asset,
  invite,
  onChange,
  onAssetChange,
  onInviteChange,
  onAddAsset,
  onInvite,
  busy,
}: {
  step: number;
  state: CompanyState;
  options: OnboardingOptions;
  asset: { asset_name: string; asset_type: string; country: string; notes: string };
  invite: { email: string; role: Role; department: string };
  onChange: (state: CompanyState) => void;
  onAssetChange: (state: { asset_name: string; asset_type: string; country: string; notes: string }) => void;
  onInviteChange: (state: { email: string; role: Role; department: string }) => void;
  onAddAsset: () => void;
  onInvite: () => void;
  busy: boolean;
}) {
  if (step === 0) {
    return (
      <Step title="Set up your company workspace" subtitle="Add your company details; everything else can be refined later.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Company name" value={state.company_name} onChange={(company_name) => onChange({ ...state, company_name })} />
          <TextField label="Website" value={state.company_website} onChange={(company_website) => onChange({ ...state, company_website })} />
          <Combobox label="Country of registration" value={state.country_of_registration} options={COUNTRY_NAMES} onChange={(country_of_registration) => onChange({ ...state, country_of_registration })} searchable allowOther placeholder="Select a country" otherPlaceholder="Enter a country" />
          <Combobox label="Primary operating country" value={state.primary_operating_country} options={COUNTRY_NAMES} onChange={(primary_operating_country) => onChange({ ...state, primary_operating_country })} searchable allowOther placeholder="Select a country" otherPlaceholder="Enter a country" />
          <SelectField label="Company type" value={state.company_type} options={options.company_types} onChange={(company_type) => onChange({ ...state, company_type })} />
          <SelectField label="Company size" value={state.company_size} options={options.company_sizes} onChange={(company_size) => onChange({ ...state, company_size })} />
        </div>
      </Step>
    );
  }
  if (step === 1) {
    return <ChoiceStep title="What does your organization mainly need PetroBrain for?" options={options.use_cases} selected={state.focus_areas} onChange={(focus_areas) => onChange({ ...state, focus_areas })} />;
  }
  if (step === 2) {
    return (
      <Step title="Jurisdiction and regulator focus" subtitle="PetroBrain will prioritize official sources for these contexts.">
        <Combobox label="Primary jurisdiction" value={state.primary_jurisdiction} options={options.regions} onChange={(primary_jurisdiction) => onChange({ ...state, primary_jurisdiction })} allowOther placeholder="Select a region" otherPlaceholder="Enter your jurisdiction" />
        <div className="mt-5">
          <ChoiceList options={options.regulator_focus} selected={state.regulator_focus} onChange={(regulator_focus) => onChange({ ...state, regulator_focus })} />
        </div>
      </Step>
    );
  }
  if (step === 3) {
    return (
      <Step title="Would you like to set up an asset now?" subtitle="Optional. Add one key field, facility, pipeline, or office, or skip this step.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Asset name" value={asset.asset_name} onChange={(asset_name) => onAssetChange({ ...asset, asset_name })} />
          <SelectField label="Asset type" value={asset.asset_type} options={options.asset_types} onChange={(asset_type) => onAssetChange({ ...asset, asset_type })} />
          <TextField label="Country" value={asset.country} onChange={(country) => onAssetChange({ ...asset, country })} />
          <TextField label="Notes" value={asset.notes} onChange={(notes) => onAssetChange({ ...asset, notes })} />
        </div>
        <button type="button" disabled={busy || !asset.asset_name.trim()} onClick={onAddAsset} className="mt-5 rounded-xl border border-primary-300 px-4 py-2 text-sm font-semibold text-primary-700 disabled:opacity-40 dark:text-primary-300">
          Add asset
        </button>
      </Step>
    );
  }
  if (step === 4) {
    return (
      <Step title="Invite your team" subtitle="Optional. Invitations are stored in PetroBrain; email delivery is only claimed when configured.">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Work email" value={invite.email} onChange={(email) => onInviteChange({ ...invite, email })} />
          <SelectField label="Role" value={invite.role} options={options.roles} onChange={(role) => onInviteChange({ ...invite, role: role as Role })} />
          <TextField label="Department" value={invite.department} onChange={(department) => onInviteChange({ ...invite, department })} />
        </div>
        <button type="button" disabled={busy || !invite.email.trim()} onClick={onInvite} className="mt-5 rounded-xl border border-primary-300 px-4 py-2 text-sm font-semibold text-primary-700 disabled:opacity-40 dark:text-primary-300">
          Create invite
        </button>
      </Step>
    );
  }
  return <Ready title="Your company workspace is ready." body="Tenant isolation, audit, safety defaults, governed sources, company folders, and role controls are configured." />;
}

function OnboardingShell({
  steps,
  current,
  children,
}: {
  steps: string[];
  current: number;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-8 dark:bg-neutral-950 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={38} glow />
            <div>
              <p className="text-sm font-semibold">PetroBrain</p>
              <p className="text-xs text-neutral-500">Workspace setup</p>
            </div>
          </div>
          <span className="text-xs font-medium text-neutral-500">Step {current + 1} of {steps.length}</span>
        </header>
        <ol className="mb-6 flex gap-2 overflow-x-auto pb-2" aria-label="Onboarding progress">
          {steps.map((label, index) => (
            <li key={label} className="min-w-fit">
              <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${
                index === current
                  ? 'bg-primary-600 text-white'
                  : index < current
                    ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                    : 'bg-white text-neutral-500 dark:bg-neutral-900'
              }`}>
                {index < current ? '✓' : index + 1} {label}
              </span>
            </li>
          ))}
        </ol>
        <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-brand-md dark:border-neutral-800 dark:bg-neutral-900 sm:p-9">
          {children}
        </section>
      </div>
    </main>
  );
}

function Step({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle ? <p className="mt-2 text-sm leading-6 text-neutral-500">{subtitle}</p> : null}
      <div className="mt-7">{children}</div>
    </div>
  );
}

function ChoiceStep({ title, options, selected, onChange }: { title: string; options: string[]; selected: string[]; onChange: (items: string[]) => void }) {
  return (
    <Step title={title} subtitle="Select all that apply. This is optional and editable later.">
      <ChoiceList options={options} selected={selected} onChange={onChange} />
    </Step>
  );
}

function ChoiceList({ options, selected, onChange }: { options: string[]; selected: string[]; onChange: (items: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? selected.filter((item) => item !== option) : [...selected, option])}
            className={`rounded-full border px-3.5 py-2 text-sm transition ${
              active
                ? 'border-primary-500 bg-primary-50 text-primary-800 dark:bg-primary-950 dark:text-primary-200'
                : 'border-neutral-200 hover:border-primary-300 dark:border-neutral-700'
            }`}
          >
            {active ? '✓ ' : ''}{option}
          </button>
        );
      })}
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = `onboarding-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <label htmlFor={id} className="block text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-300">
      {label}
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-11 w-full rounded-xl border border-neutral-200 bg-white px-3.5 text-sm font-normal normal-case tracking-normal text-neutral-900 outline-none transition-all hover:border-primary-300 focus:border-primary-400 focus:ring-2 focus:ring-primary-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100" />
    </label>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <Select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={[
        { value: '', label: 'Select' },
        ...options.map((option) => ({ value: option, label: formatOption(option) })),
      ]}
    />
  );
}

function Ready({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-8 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-2xl text-green-700 dark:bg-green-950 dark:text-green-300">✓</span>
      <h1 className="mt-5 text-2xl font-semibold">{title}</h1>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-neutral-500">{body}</p>
    </div>
  );
}

function LoadingOnboarding() {
  return <main className="grid min-h-screen place-items-center"><p className="animate-pulse text-sm text-neutral-500">Preparing your PetroBrain workspace...</p></main>;
}

function OnboardingError({ message }: { message: string }) {
  return <main className="grid min-h-screen place-items-center px-4"><p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{message}</p></main>;
}

function hydrateAnswers(
  answers: Record<string, unknown>,
  knownName: string,
  setIndividual: (value: IndividualState) => void,
  setCompany: (value: CompanyState) => void,
) {
  const merged = { ...INITIAL_INDIVIDUAL, ...(answers as Partial<IndividualState>) };
  // Reuse the name captured at signup so we never ask the user for it again.
  if (!merged.full_name.trim() && knownName.trim()) merged.full_name = knownName.trim();
  setIndividual(merged);
  setCompany({ ...INITIAL_COMPANY, ...(answers as Partial<CompanyState>) });
}

function validateIndividual(state: IndividualState, step: number) {
  if (step === 0 && (!state.full_name.trim() || !state.country.trim())) {
    throw new Error('Full name and country are required.');
  }
}

function validateCompany(state: CompanyState, step: number) {
  if (step !== 0) return;
  if (!state.company_name.trim() || !state.country_of_registration.trim()
    || !state.primary_operating_country.trim() || !state.company_type || !state.company_size) {
    throw new Error('Complete the required company profile fields.');
  }
}

function formatOption(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : 'Could not save this step.';
}

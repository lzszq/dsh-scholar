import { RUNNER_PROFILE_IDS } from '@dsh-scholar/research-schemas'
import { ResearchKernel } from '@dsh-scholar/research-kernel'

/**
 * Unit-test fixture for scenarios that assume an execution environment is
 * already selected. Production `ResearchKernel` deliberately persists an
 * omitted profile as null; these tests make their unrelated prerequisite
 * explicit without repeating it in hundreds of setup literals. Name-only
 * collecting projects retain the production unconfigured state.
 */
export class ConfiguredTestKernel extends ResearchKernel {
  override createProject(input: Parameters<ResearchKernel['createProject']>[0]) {
    return super.createProject({
      ...input,
      ...(input.session_id !== undefined && input.session_id !== null && input.creator_principal_id === undefined
        ? { creator_principal_id: 'test-session-owner', creator_tenant_id: 'test-tenant', session_issuer: 'kernel' as const }
        : {}),
      ...(input.brief_status === 'collecting'
        ? {}
        : {
            execution: {
              runner_profile_id: RUNNER_PROFILE_IDS.localDockerCpu,
              ...(input.execution ?? {}),
            },
          }),
    })
  }
}

/** Generic details-column host with the built-in Tool view as its default. */
import { DetailsViewShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DetailsHostSlotProps, DetailsSlotProps } from '../contract/slots.ts'
import { TOOL_DETAILS_VIEW_ID } from '../details-controller.ts'
import { DetailsPanel } from './DetailsPanel.tsx'
import css from './DetailsViewHost.module.css'

/** Full props composed from the details host registration. */
export type DetailsViewHostProps = DetailsHostSlotProps

/** Render the selected additive details view or the built-in Tool panel. */
export function DetailsViewHost(props: DetailsViewHostProps) {
  const active = props.useDetailsView(viewId => viewId)
  if (active === TOOL_DETAILS_VIEW_ID) {
    const toolProps: DetailsSlotProps = props
    return <DetailsPanel {...toolProps} />
  }
  return props.renderSlot('conversation.details.view', { closeDetails: props.closeDetails }, {
    only: active,
    fallback: (
      <DetailsViewShell
        title={props.t('details.unavailableTitle')}
        closeLabel={props.t('details.close')}
        onClose={props.closeDetails}
      >
        <p className={css.message}>{props.t('details.unavailable')}</p>
      </DetailsViewShell>
    ),
  })
}

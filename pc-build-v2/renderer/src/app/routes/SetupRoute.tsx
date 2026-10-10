import { SetupFlow } from '../../features/setup'
import { useRouter, type SetupIntent } from '../router'

const NEW_PROFILE: SetupIntent = { kind: 'new' }

/**
 * Full-window setup route (no command bar). Leaving it only ends the setup session and
 * returns to the previous destination; monitoring keeps running.
 */
export function SetupRoute({
  intent = NEW_PROFILE,
}: {
  intent?: SetupIntent | undefined
}): React.JSX.Element {
  const { back } = useRouter()
  return <SetupFlow intent={intent} onExit={() => back()} />
}

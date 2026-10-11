import { useProfiles } from '../../features/profiles'
import { OpponentScreen } from '../../features/opponent/OpponentScreen'
import { State } from '../../ui'

/** «Игра»: opponent card, session counters, history and summary. */
export function MainRoute(): React.JSX.Element {
  const profiles = useProfiles()
  if (profiles.value === null && profiles.error === null)
    return <State icon="clock" title="Загружаем данные…" />
  return <OpponentScreen />
}

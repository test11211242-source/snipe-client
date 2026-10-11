import {
  AppWindow,
  ArrowUp,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronLeft,
  ChartNoAxesColumn,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  History,
  ScanLine,
  Layers,
  LayoutGrid,
  Lock,
  LogOut,
  MessageSquare,
  Minus,
  Minimize2,
  Monitor,
  Pencil,
  Pin,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Square,
  Target,
  Trash2,
  Trophy,
  TriangleAlert,
  Tv,
  Type,
  User,
  Users,
  WandSparkles,
  WifiOff,
  X,
  Ellipsis,
  type LucideIcon,
} from 'lucide-react'

/** Icon names used by the design. Add here, never import lucide in feature code. */
const ICONS = {
  alert: TriangleAlert,
  arrowUp: ArrowUp,
  bell: Bell,
  broadcast: Radio,
  check: Check,
  checkCircle: CircleCheck,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  chevronLeft: ChevronLeft,
  chart: ChartNoAxesColumn,
  chat: MessageSquare,
  clock: Clock,
  close: X,
  copy: Copy,
  download: Download,
  scan: ScanLine,
  edit: Pencil,
  external: ExternalLink,
  eye: Eye,
  eyeOff: EyeOff,
  gear: Settings,
  grid: LayoutGrid,
  info: Info,
  history: History,
  layers: Layers,
  lock: Lock,
  logout: LogOut,
  maximize: Square,
  minimize: Minus,
  compact: Minimize2,
  monitor: Monitor,
  more: Ellipsis,
  pin: Pin,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  repeat: Repeat,
  search: Search,
  shield: Shield,
  sliders: SlidersHorizontal,
  stop: Square,
  target: Target,
  trash: Trash2,
  trophy: Trophy,
  twitch: Tv,
  title: Type,
  user: User,
  users: Users,
  wand: WandSparkles,
  wifiOff: WifiOff,
  window: AppWindow,
  xCircle: CircleX,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

interface IconProps {
  name: IconName
  size?: number
  className?: string | undefined
}

/** Decorative icon; give the surrounding control an accessible name. */
export function Icon({ name, size = 16, className }: IconProps): React.JSX.Element {
  const Component = ICONS[name]
  const filled = name === 'play' || name === 'stop'
  return (
    <Component
      aria-hidden="true"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      size={size}
      strokeWidth={filled ? 0 : 1.7}
      style={{ flex: 'none' }}
    />
  )
}

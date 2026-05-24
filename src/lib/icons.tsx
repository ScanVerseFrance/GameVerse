/**
 * Shim d'icônes — remplacement de `lucide-react` par Heroicons (24/outline)
 * + Bootstrap Icons en fallback pour les pictos absents d'Heroicons.
 *
 * Pourquoi : feedback user "les icônes lucide font trop IA". On bascule
 * sur un set design plus mainstream (Tailwind team + Bootstrap team).
 *
 * API compat — chaque ré-export ci-dessous est un wrapper qui accepte
 * les mêmes props que lucide-react (`size`, `strokeWidth`, `className`,
 * `color`, etc.) pour qu'aucun callsite n'ait à être adapté à la main.
 *
 * Mapping (lucide → heroicons/bootstrap) :
 *   - Heroicons couvre ~75% des cas (UI commune)
 *   - Bootstrap Icons couvre le reste (gamepad, memory, save floppy,
 *     dice, scan, gem, crown, etc.)
 *
 * Style par défaut : Heroicons outline 24 + strokeWidth 1.5 (default).
 * Pour matcher l'épaisseur de lucide (strokeWidth=2), on peut passer
 * explicitement la prop. La plupart des callsites utilisent juste
 * `className="w-X h-X"` donc le défaut convient.
 */
import type { ComponentProps, SVGProps } from 'react'

// ─── Heroicons (24/outline) ──────────────────────────────────────────
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowDownTrayIcon,
  ArrowLeftEndOnRectangleIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightEndOnRectangleIcon,
  ArrowRightIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon,
  ArrowsUpDownIcon,
  ArrowTopRightOnSquareIcon,
  ArrowTrendingDownIcon,
  ArrowTrendingUpIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  Bars3BottomLeftIcon,
  Bars3Icon,
  BellIcon,
  BoltIcon,
  BookOpenIcon,
  CalendarDaysIcon,
  CalendarIcon,
  CameraIcon,
  ChartBarIcon,
  ChatBubbleLeftIcon,
  ChatBubbleOvalLeftIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleStackIcon,
  ClockIcon,
  CloudArrowUpIcon,
  CloudIcon,
  Cog6ToothIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  CubeIcon,
  DocumentArrowDownIcon,
  DocumentDuplicateIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  FaceSmileIcon,
  FireIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FunnelIcon,
  GlobeAltIcon,
  GlobeAmericasIcon,
  HeartIcon,
  HomeIcon,
  InboxIcon,
  InformationCircleIcon,
  KeyIcon,
  LanguageIcon,
  LinkIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  MinusIcon,
  MoonIcon,
  MusicalNoteIcon,
  NewspaperIcon,
  NoSymbolIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  PauseIcon,
  PencilIcon,
  PencilSquareIcon,
  PhotoIcon,
  PlayIcon,
  PlusIcon,
  PuzzlePieceIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  Square3Stack3DIcon,
  Squares2X2Icon,
  SparklesIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  StarIcon,
  StopIcon,
  SwatchIcon,
  TagIcon,
  TrashIcon,
  TrophyIcon,
  UserIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  WifiIcon,
  WrenchIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'

// ─── Bootstrap Icons (fallback pour ce que Heroicons n'a pas) ──────
import {
  Award as BsCrown, // pas de Crown chez bootstrap-icons, Award (médaille ruban) est le + proche visuellement
  Bullseye,
  Circle as BsCircle,
  CloudSlash,
  CompassFill,
  Controller,
  Diagram3,
  Dice5,
  FiletypeJson,
  Floppy,
  FolderSymlink,
  Gem as BsGem,
  Hdd,
  Keyboard as BsKeyboard,
  Magic,
  Magnet as BsMagnet,
  Memory,
  Octagon,
  RecordCircle,
  StickyFill,
  Stopwatch,
  TextIndentLeft,
  UpcScan,
  WifiOff as BsWifiOff,
  type Icon as BsIcon,
} from 'react-bootstrap-icons'

// ─── Types ──────────────────────────────────────────────────────────
/** API lucide-react-compat. `size` → width+height, le reste forwardé. */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: number | string
  /** Compat lucide. Heroicons par défaut = 1.5, lucide = 2. */
  strokeWidth?: number | string
  /** Alias usage : <Icon color="..."/> = couleur du stroke/fill. */
  color?: string
}

type HeroIconType = React.ForwardRefExoticComponent<
  ComponentProps<'svg'> & { title?: string; titleId?: string } & React.RefAttributes<SVGSVGElement>
>

// react-bootstrap-icons exporte ses icônes en tant que FC<IconProps>
// (un FunctionComponent, pas un ForwardRef). On réutilise leur
// alias type pour rester en phase.
type BsIconType = BsIcon

// ─── Wrapper factories ──────────────────────────────────────────────
/** Wrap un composant Heroicon en lui ajoutant le support de `size`,
 *  `strokeWidth`, `color`. Conserve le default 1.5 quand strokeWidth
 *  n'est pas fourni. */
function wrapHero(Hero: HeroIconType) {
  function Wrapped({ size, strokeWidth, color, style, ...rest }: IconProps) {
    const finalStyle =
      size != null ? { width: size, height: size, ...(style ?? {}) } : style
    const colorStyle = color ? { color, ...(finalStyle ?? {}) } : finalStyle
    return (
      <Hero
        {...(rest as ComponentProps<'svg'>)}
        style={colorStyle as React.CSSProperties}
        strokeWidth={strokeWidth as number | undefined}
      />
    )
  }
  Wrapped.displayName = (Hero.displayName || 'HeroIcon') + 'Compat'
  return Wrapped
}

/** Wrap un composant Bootstrap Icon. Bootstrap accepte déjà `size`
 *  natif ; on uniformise juste avec lucide pour les autres props. */
function wrapBs(Bs: BsIconType) {
  function Wrapped({ size, color, style, ...rest }: IconProps) {
    const colorStyle = color ? { color, ...(style ?? {}) } : style
    return (
      <Bs
        {...(rest as React.SVGProps<SVGSVGElement>)}
        size={size}
        style={colorStyle as React.CSSProperties}
      />
    )
  }
  Wrapped.displayName = (Bs.displayName || 'BsIcon') + 'Compat'
  return Wrapped
}

// ─── Type alias compat — certains modules importent `LucideIcon`
// pour typer des refs d'icônes. On expose le même nom. ──────────────
export type LucideIcon = (props: IconProps) => React.JSX.Element

// ─── Exports (noms lucide-react) ────────────────────────────────────
// Heroicons mappings
export const Activity = wrapHero(BoltIcon)
export const AlertCircle = wrapHero(ExclamationCircleIcon)
export const AlertTriangle = wrapHero(ExclamationTriangleIcon)
export const ArrowLeft = wrapHero(ArrowLeftIcon)
export const ArrowRight = wrapHero(ArrowRightIcon)
export const ArrowUpDown = wrapHero(ArrowsUpDownIcon)
export const Award = wrapHero(TrophyIcon) // pas d'Award natif → Trophy
export const Ban = wrapHero(NoSymbolIcon)
export const Bell = wrapHero(BellIcon)
export const Calendar = wrapHero(CalendarIcon)
export const CalendarDays = wrapHero(CalendarDaysIcon)
export const Camera = wrapHero(CameraIcon)
export const Check = wrapHero(CheckIcon)
export const CheckCircle2 = wrapHero(CheckCircleIcon)
export const ChevronDown = wrapHero(ChevronDownIcon)
export const ChevronLeft = wrapHero(ChevronLeftIcon)
export const ChevronRight = wrapHero(ChevronRightIcon)
export const ChevronUp = wrapHero(ChevronUpIcon)
export const Clock = wrapHero(ClockIcon)
export const Cloud = wrapHero(CloudIcon)
export const CloudUpload = wrapHero(CloudArrowUpIcon)
export const Copy = wrapHero(DocumentDuplicateIcon)
export const Cpu = wrapHero(CpuChipIcon)
export const Database = wrapHero(CircleStackIcon)
export const Download = wrapHero(ArrowDownTrayIcon)
export const Edit3 = wrapHero(PencilSquareIcon)
export const ExternalLink = wrapHero(ArrowTopRightOnSquareIcon)
export const Filter = wrapHero(FunnelIcon)
export const Flame = wrapHero(FireIcon)
export const Folder = wrapHero(FolderIcon)
export const FolderOpen = wrapHero(FolderOpenIcon)
export const FolderPlus = wrapHero(FolderPlusIcon)
export const Globe = wrapHero(GlobeAltIcon)
export const Globe2 = wrapHero(GlobeAmericasIcon)
export const Image = wrapHero(PhotoIcon)
export const Info = wrapHero(InformationCircleIcon)
export const Languages = wrapHero(LanguageIcon)
export const Layers = wrapHero(Square3Stack3DIcon)
export const LayoutGrid = wrapHero(Squares2X2Icon)
export const Library = wrapHero(BookOpenIcon)
export const Loader2 = wrapHero(ArrowPathIcon) // spinner
export const Lock = wrapHero(LockClosedIcon)
export const Maximize2 = wrapHero(ArrowsPointingOutIcon)
export const MessageCircle = wrapHero(ChatBubbleOvalLeftIcon)
export const MessageSquare = wrapHero(ChatBubbleLeftIcon)
export const Minus = wrapHero(MinusIcon)
export const Moon = wrapHero(MoonIcon)
export const Music = wrapHero(MusicalNoteIcon)
export const Newspaper = wrapHero(NewspaperIcon)
export const Package = wrapHero(CubeIcon)
export const Paintbrush = wrapHero(PaintBrushIcon)
export const Palette = wrapHero(SwatchIcon)
export const Pause = wrapHero(PauseIcon)
export const Pencil = wrapHero(PencilIcon)
export const Pin = wrapHero(MapPinIcon)
export const Play = wrapHero(PlayIcon)
export const Plus = wrapHero(PlusIcon)
export const Puzzle = wrapHero(PuzzlePieceIcon)
export const RefreshCw = wrapHero(ArrowPathIcon)
export const Rows3 = wrapHero(Bars3Icon)
export const Search = wrapHero(MagnifyingGlassIcon)
export const Send = wrapHero(PaperAirplaneIcon)
export const Settings = wrapHero(Cog6ToothIcon)
export const Settings2 = wrapHero(AdjustmentsHorizontalIcon)
export const Sparkles = wrapHero(SparklesIcon)
export const Square = wrapHero(StopIcon)
export const Star = wrapHero(StarIcon)
export const Trash = wrapHero(TrashIcon)
export const Trash2 = wrapHero(TrashIcon)
export const Trophy = wrapHero(TrophyIcon)
export const Upload = wrapHero(ArrowUpTrayIcon)
export const User = wrapHero(UserIcon)
export const UserPlus = wrapHero(UserPlusIcon)
export const Users = wrapHero(UsersIcon)
export const Volume2 = wrapHero(SpeakerWaveIcon)
export const VolumeX = wrapHero(SpeakerXMarkIcon)
export const Wifi = wrapHero(WifiIcon)
export const Wrench = wrapHero(WrenchIcon)
export const X = wrapHero(XMarkIcon)

// Bootstrap Icons fallback (Heroicons n'a pas ces designs)
export const CloudOff = wrapBs(CloudSlash)
export const Compass = wrapBs(CompassFill)
export const Crown = wrapBs(BsCrown)
export const Dices = wrapBs(Dice5)
export const FileJson = wrapBs(FiletypeJson)
export const FolderCog = wrapBs(FolderSymlink)
export const FolderTree = wrapBs(Diagram3)
export const Gamepad2 = wrapBs(Controller)
export const Gem = wrapBs(BsGem)
export const HardDrive = wrapBs(Hdd)
export const Keyboard = wrapBs(BsKeyboard)
export const MemoryStick = wrapBs(Memory)
export const Save = wrapBs(Floppy)
export const ScanLine = wrapBs(UpcScan)
export const StickyNote = wrapBs(StickyFill)

// Chart icon explicite si certains usages le veulent (sinon Bolt) :
export const ChartBar = wrapHero(ChartBarIcon)
export const WrenchScrewdriver = wrapHero(WrenchScrewdriverIcon)

// ─── Suite Heroicons (couvre des noms supplémentaires) ─────────────
export const BarChart3 = wrapHero(ChartBarIcon)
export const BookOpen = wrapHero(BookOpenIcon)
export const Computer = wrapHero(ComputerDesktopIcon)
export const Eye = wrapHero(EyeIcon)
export const EyeOff = wrapHero(EyeSlashIcon)
export const FileArchive = wrapHero(ArchiveBoxIcon)
export const FileDown = wrapHero(DocumentArrowDownIcon)
export const Heart = wrapHero(HeartIcon)
export const HelpCircle = wrapHero(QuestionMarkCircleIcon)
export const Home = wrapHero(HomeIcon)
export const Inbox = wrapHero(InboxIcon)
export const KeyRound = wrapHero(KeyIcon)
export const Link2 = wrapHero(LinkIcon)
export const LogIn = wrapHero(ArrowLeftEndOnRectangleIcon)
export const LogOut = wrapHero(ArrowRightEndOnRectangleIcon)
export const Monitor = wrapHero(ComputerDesktopIcon)
export const Move = wrapHero(ArrowsRightLeftIcon)
export const Outdent = wrapHero(Bars3BottomLeftIcon)
export const PenLine = wrapHero(PencilIcon)
export const RotateCcw = wrapHero(ArrowUturnLeftIcon)
export const Shield = wrapHero(ShieldCheckIcon)
export const ShieldCheck = wrapHero(ShieldCheckIcon)
export const ShieldAlert = wrapHero(ShieldExclamationIcon)
export const SlidersHorizontal = wrapHero(AdjustmentsHorizontalIcon)
export const Smile = wrapHero(FaceSmileIcon)
export const Tag = wrapHero(TagIcon)
export const TrendingDown = wrapHero(ArrowTrendingDownIcon)
export const TrendingUp = wrapHero(ArrowTrendingUpIcon)
export const UserMinus = wrapHero(UserMinusIcon)
export const Zap = wrapHero(BoltIcon)
// CheckCheck → bootstrap CheckAll style. Heroicons CheckBadge a un
// double-check stylisé, ça suffit pour l'usage notif "marquer comme lu".
export const CheckCheck = wrapHero(CheckBadgeIcon)

// ─── Suite Bootstrap Icons ──────────────────────────────────────────
export const AlertOctagon = wrapBs(Octagon)
export const Circle = wrapBs(BsCircle)
export const CircleDot = wrapBs(RecordCircle)
export const Crosshair = wrapBs(Bullseye)
export const Magnet = wrapBs(BsMagnet)
export const Navigation = wrapBs(CompassFill)
export const Target = wrapBs(Bullseye)
export const Timer = wrapBs(Stopwatch)
export const Wand2 = wrapBs(Magic)
export const WifiOff = wrapBs(BsWifiOff)
// Outdent côté Bootstrap pour expériences plus proches du textuel :
export const TextIndent = wrapBs(TextIndentLeft)

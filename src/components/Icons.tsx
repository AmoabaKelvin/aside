import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PinIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p}>
    <path d="M9.6 2.2 13.8 6.4a.6.6 0 0 1-.1.95l-1.95 1.05-2.1 3.15a.6.6 0 0 1-.92.1L4.35 7.27a.6.6 0 0 1 .1-.92L7.6 4.25 8.65 2.3a.6.6 0 0 1 .95-.1Z" fill={filled ? 'currentColor' : 'none'} />
    <path d="M6.5 9.5 2.5 13.5" />
  </Icon>
)

export const ComposeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 8.5v3.75a1.75 1.75 0 0 1-1.75 1.75h-7.5a1.75 1.75 0 0 1-1.75-1.75v-7.5A1.75 1.75 0 0 1 4.25 3H8" />
    <path d="M11.6 2.4a1.27 1.27 0 0 1 1.8 1.8L8.2 9.4 6 10l.6-2.2 5-5.4Z" />
  </Icon>
)

export const GearIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58" />
  </Icon>
)

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
    <circle cx="5.75" cy="6.25" r="1.1" />
    <path d="m2.5 11.5 3.2-3.1a1 1 0 0 1 1.38 0L10 11.25M9 10.25l1.2-1.15a1 1 0 0 1 1.38 0L13.75 11" />
  </Icon>
)

export const ArrowUpIcon = (p: IconProps) => (
  <Icon strokeWidth={1.8} {...p}>
    <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" />
  </Icon>
)

export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="2" />
    <path d="M10.75 3.25A1.5 1.5 0 0 0 9.25 2H4a2 2 0 0 0-2 2v5.25a1.5 1.5 0 0 0 1.25 1.48" />
  </Icon>
)

export const CheckIcon = (p: IconProps) => (
  <Icon strokeWidth={1.7} {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
)

export const CloseIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Icon>
)

export const ChevronDownIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </Icon>
)

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Icon>
)

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </Icon>
)

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M2.5 8h11M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25Z" />
  </Icon>
)

export const SparkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M4.1 11.9l1.4-1.4M10.5 5.5l1.4-1.4" />
  </Icon>
)

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.25" />
    <circle cx="8" cy="10.75" r="0.4" fill="currentColor" />
  </Icon>
)

export const ArrowDownIcon = (p: IconProps) => (
  <Icon strokeWidth={1.6} {...p}>
    <path d="M8 3.5V12.5M4 8.5l4 4 4-4" />
  </Icon>
)

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 4.75A1.75 1.75 0 0 1 3.75 3h2.4l1.5 1.5h4.6A1.75 1.75 0 0 1 14 6.25v5A1.75 1.75 0 0 1 12.25 13h-8.5A1.75 1.75 0 0 1 2 11.25v-6.5Z" />
  </Icon>
)

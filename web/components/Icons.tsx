/** 작은 선 아이콘. 글자색(currentColor)을 따른다. 이모지 대신 쓴다 */
type P = { size?: number; className?: string };

export function PinIcon({ size = 16, className }: P) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 14.5s4.5-4.2 4.5-7.7A4.5 4.5 0 0 0 3.5 6.8c0 3.5 4.5 7.7 4.5 7.7Z"
        fill="currentColor"
      />
      <circle cx="8" cy="6.8" r="1.7" fill="#fff" />
    </svg>
  );
}

export function ChevronDown({ size = 12, className }: P) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className }: P) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: P) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function InfoIcon({ size = 18, className }: P) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <circle cx="9" cy="9" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 8.2v4.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9" cy="5.6" r="1" fill="currentColor" />
    </svg>
  );
}

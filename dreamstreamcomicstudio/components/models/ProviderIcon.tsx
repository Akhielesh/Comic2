import React from 'react';
import { getModelVendor, getVendorById, type VendorMeta } from '../../services/modelVendors';
import { ProviderLogo, hasProviderLogo } from '../providerLogos';
import { getProviderDef } from '../../shared/providers';

// Official provider marks, rendered inline so the catalog never depends on a CDN.
// Every vendor in VENDOR_META either has a real brand SVG here or falls back to a
// standardized monogram chip (same geometry, vendor brand color), so provider rows
// stay visually uniform. Brand SVG sources: each company's published logo mark.

interface IconProps {
  className?: string;
}

const svgProps = (className?: string) => ({
  className: className ?? 'w-4 h-4',
  'aria-hidden': true as const,
  focusable: false as const
});

const AnthropicMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 24" fill="#D97757" fillRule="evenodd">
    <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
  </svg>
);

const OpenAIMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

// Gemini four-point star (Google AI brand mark).
const GoogleMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 296 298">
    <path
      fill="#3186FF"
      d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
    />
  </svg>
);

const DeepSeekMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 24">
    <path
      fill="#4D6BFE"
      d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
    />
  </svg>
);

const QwenMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 24" fill="#7C3AED" fillRule="evenodd">
    <path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031z" />
  </svg>
);

// NVIDIA "eye" mark (cropped from the full lockup so it reads at 14px).
const NvidiaMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="52 28 258 172">
    <path
      fill="#77B900"
      d="M82.211 102.414s22.504-33.203 67.437-36.638V53.73c-49.769 3.997-92.867 46.149-92.867 46.149s24.41 70.565 92.867 77.026v-12.804c-50.237-6.32-67.437-61.687-67.437-61.687zm67.437 36.223v11.726c-37.968-6.769-48.507-46.237-48.507-46.237s18.23-20.195 48.507-23.47v12.867c-.023 0-.039-.007-.058-.007-15.891-1.907-28.305 12.938-28.305 12.938s6.958 24.991 28.363 32.183m0-107.125V53.73c1.461-.112 2.922-.207 4.391-.257 56.582-1.907 93.449 46.406 93.449 46.406s-42.343 51.488-86.457 51.488c-4.043 0-7.828-.375-11.383-1.005v13.739c3.04.386 6.192.613 9.481.613 41.051 0 70.738-20.965 99.484-45.778 4.766 3.817 24.278 13.103 28.289 17.168-27.332 22.883-91.031 41.329-127.144 41.329-3.481 0-6.824-.211-10.11-.528v19.306h-19.306V31.512h19.306zm0 49.144V65.777c1.446-.101 2.903-.179 4.391-.226 40.688-1.278 67.382 34.965 67.382 34.965s-28.832 40.043-59.746 40.043c-4.449 0-8.438-.715-12.028-1.922V93.523c15.84 1.914 19.028 8.911 28.551 24.786l21.18-17.859s-15.461-20.277-41.524-20.277c-2.833-.001-5.544.198-8.206.483"
    />
  </svg>
);

const MetaMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 24" fill="none">
    <path
      d="M12 12c-1.8-2.9-3.5-4.8-5.7-4.8C3.8 7.2 2 9.3 2 12s1.8 4.8 4.3 4.8c2.2 0 3.9-1.9 5.7-4.8zm0 0c1.8 2.9 3.5 4.8 5.7 4.8 2.5 0 4.3-2.1 4.3-4.8s-1.8-4.8-4.3-4.8c-2.2 0-3.9 1.9-5.7 4.8z"
      stroke="#0081FB"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Mistral pixel-flag "M" (yellow → red rows).
const MISTRAL_ROWS: { y: number; color: string; cols: number[] }[] = [
  { y: 0, color: '#FFD800', cols: [0, 5] },
  { y: 1, color: '#FFAF00', cols: [0, 1, 4, 5] },
  { y: 2, color: '#FF8205', cols: [0, 2, 3, 5] },
  { y: 3, color: '#FA500F', cols: [0, 5] },
  { y: 4, color: '#E10500', cols: [0, 5] }
];
const MistralMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 20">
    {MISTRAL_ROWS.map((row) =>
      row.cols.map((c) => <rect key={`${row.y}-${c}`} x={c * 4} y={row.y * 4} width="4" height="4" fill={row.color} />)
    )}
  </svg>
);

const XaiMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 841.89 595.28" fill="currentColor">
    <path d="m557.09 211.99 8.31 326.37h66.56l8.32-445.18zM640.28 56.91H538.72L379.35 284.53l50.78 72.52zM201.61 538.36h101.56l50.79-72.52-50.79-72.53zM201.61 211.99l228.52 326.37h101.56L303.17 211.99z" />
  </svg>
);

const CohereMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 75 75">
    <path fill="#39594d" fillRule="evenodd" clipRule="evenodd" d="M24.3 44.7c2 0 6-.1 11.6-2.4 6.5-2.7 19.3-7.5 28.6-12.5 6.5-3.5 9.3-8.1 9.3-14.3C73.8 7 66.9 0 58.3 0h-36C10 0 0 10 0 22.3s9.4 22.4 24.3 22.4z" />
    <path fill="#d18ee2" fillRule="evenodd" clipRule="evenodd" d="M30.4 60c0-6 3.6-11.5 9.2-13.8l11.3-4.7C62.4 36.8 75 45.2 75 57.6 75 67.2 67.2 75 57.6 75H45.3c-8.2 0-14.9-6.7-14.9-15z" />
    <path fill="#ff7759" d="M12.9 47.6C5.8 47.6 0 53.4 0 60.5v1.7C0 69.2 5.8 75 12.9 75c7.1 0 12.9-5.8 12.9-12.9v-1.7c-.1-7-5.8-12.8-12.9-12.8z" />
  </svg>
);

const PerplexityMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 48 48" fill="none" stroke="#20808d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
    <path d="M24 4.5v39M13.73 16.573v-9.99L24 16.573m0 14.5L13.73 41.417V27.01L24 16.573m0 0l10.27-9.99v9.99" />
    <path d="M13.73 31.396H9.44V16.573h29.12v14.823h-4.29" />
    <path d="M24 16.573 34.27 27.01v14.407L24 31.073" />
  </svg>
);

const StabilityMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 256 213">
    <defs>
      <linearGradient id="ds-stability-grad" x1="50%" x2="50%" y1="0%" y2="100%">
        <stop offset="0%" stopColor="#9D39FF" />
        <stop offset="100%" stopColor="#A380FF" />
      </linearGradient>
    </defs>
    <path
      fill="url(#ds-stability-grad)"
      d="M72.418 212.45c49.478 0 81.658-26.205 81.658-65.626 0-30.572-19.572-49.998-54.569-58.043l-22.469-6.74c-19.71-4.424-31.215-9.738-28.505-23.312 2.255-11.292 9.002-17.667 24.69-17.667 49.872 0 68.35 17.667 68.35 17.667V16.237S123.583 0 73.223 0C25.757 0 0 24.424 0 62.236c0 30.571 17.85 48.35 54.052 56.798 2.534.633 3.83.959 3.885.976 5.507 1.704 12.938 3.956 22.293 6.755 18.504 4.425 23.262 9.121 23.262 23.2 0 12.872-13.374 20.19-31.074 20.19C21.432 170.154 0 144.36 0 144.36v47.078s13.402 21.01 72.418 21.01Z"
    />
    <path fill="#E80000" d="M225.442 209.266c17.515 0 30.558-12.67 30.558-29.812 0-17.515-12.67-29.813-30.558-29.813-17.515 0-30.185 12.298-30.185 29.813s12.67 29.812 30.185 29.812Z" />
  </svg>
);

// Moonshot Kimi "K" tile.
const MoonshotMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 512 512" fillRule="evenodd" clipRule="evenodd">
    <path d="M503 114.333v280c0 60.711-49.29 110-110 110H113c-60.711 0-110-49.289-110-110v-280c0-60.71 49.289-110 110-110h280c60.71 0 110 49.29 110 110z" />
    <path fill="#027aff" d="M342.065 189.759c1.886-2.42 3.541-4.63 5.289-6.77.81-1.007.74-1.771-.046-2.824-7.58-9.965-8.298-21.028-3.935-32.254 3.275-8.448 10.52-12.406 19.373-13.25 5.52-.521 10.936.046 15.959 2.73 6.596 3.53 10.438 8.912 11.688 16.341.995 5.926.81 11.712-.868 17.452-2.974 10.161-10.277 15.427-20.287 16.758-8.31 1.11-16.734 1.25-25.113 1.817-.648.046-1.308 0-2.06 0z" />
    <path fill="#fff" d="M321.512 144.254h-50.064l-39.637 90.384h-56.036v-89.99H131v232.868h44.787v-98.103h78.973c13.598 0 26.015-7.927 31.744-20.252v118.355h44.787v-98.103c0-23.342-18.239-42.97-41.523-44.671v-.116h-24.593a45.577 45.577 0 0026.884-24.534l29.453-65.838z" />
  </svg>
);

const MicrosoftMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 23 23">
    <rect x="1" y="1" width="10" height="10" fill="#F25022" />
    <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
    <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
    <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
  </svg>
);

const AmazonMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 24 24">
    <rect x="0" y="0" width="24" height="24" rx="5" fill="#232F3E" />
    <text x="12" y="13.5" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">a</text>
    <path d="M6.5 15.5c3.4 2.6 7.6 2.6 11 0" stroke="#FF9900" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <path d="M17.5 15.5l-.3 1.7 1.8-.9z" fill="#FF9900" />
  </svg>
);

const OpenRouterMark: React.FC<IconProps> = ({ className }) => (
  <svg {...svgProps(className)} viewBox="0 0 512 512" fill="currentColor" stroke="currentColor">
    <path d="M3 248.945C18 248.945 76 236 106 219C136 202 136 202 198 158C276.497 102.293 332 120.945 423 120.945" strokeWidth="90" fill="none" />
    <path d="M511 121.5L357.25 210.268L357.25 32.7324L511 121.5Z" />
    <path d="M0 249C15 249 73 261.945 103 278.945C133 295.945 133 295.945 195 339.945C273.497 395.652 329 377 420 377" strokeWidth="90" fill="none" />
    <path d="M508 376.445L354.25 287.678L354.25 465.213L508 376.445Z" />
  </svg>
);

/** Vendors with a real brand mark; everything else gets the standardized monogram. */
export const PROVIDER_ICONS: Record<string, React.FC<IconProps>> = {
  anthropic: AnthropicMark,
  openai: OpenAIMark,
  google: GoogleMark,
  deepseek: DeepSeekMark,
  qwen: QwenMark,
  nvidia: NvidiaMark,
  meta: MetaMark,
  mistral: MistralMark,
  xai: XaiMark,
  cohere: CohereMark,
  perplexity: PerplexityMark,
  stability: StabilityMark,
  moonshot: MoonshotMark,
  microsoft: MicrosoftMark,
  amazon: AmazonMark
};

// Monogram colors come from the vendor badge classes so chips and icons agree.
const Monogram: React.FC<{ vendor: VendorMeta; className?: string }> = ({ vendor, className }) => (
  <span
    aria-hidden
    className={`inline-flex items-center justify-center rounded font-bold text-[0.62em] leading-none select-none border border-black/20 ${vendor.color} ${className ?? 'w-4 h-4'}`}
  >
    {vendor.label.charAt(0).toUpperCase()}
  </span>
);

/**
 * The stock icon for an AI model provider/vendor. `vendorId` is the canonical id
 * from modelVendors (e.g. "anthropic"); unknown vendors render a colored monogram
 * with identical geometry so mixed lists stay aligned.
 */
export const ProviderIcon: React.FC<{ vendorId: string; className?: string }> = ({ vendorId, className }) => {
  const Mark = PROVIDER_ICONS[vendorId];
  if (Mark) return <Mark className={className} />;
  return <Monogram vendor={getVendorById(vendorId)} className={className} />;
};

/** Convenience: icon straight from a catalog model (derives the vendor from the id). */
export const ModelProviderIcon: React.FC<{ model: { id: string }; className?: string }> = ({ model, className }) => (
  <ProviderIcon vendorId={getModelVendor(model).id} className={className} />
);

/** Icon for the upstream SOURCE gateway (where the request is routed), not the maker.
 *  Renders the real brand mark for every provider in the registry (OpenRouter, NVIDIA,
 *  OpenAI, Anthropic, Gemini, DeepSeek, Z.AI, MiniMax, Tencent, xAI), tinted to its accent. */
export const SourceIcon: React.FC<{ source: 'openrouter' | 'nvidia' | string; className?: string }> = ({ source, className }) => {
  if (hasProviderLogo(source)) {
    return <ProviderLogo provider={source} className={className ?? 'w-4 h-4'} style={{ color: getProviderDef(source)?.accent }} />;
  }
  return source === 'nvidia' ? <NvidiaMark className={className} /> : <OpenRouterMark className={className} />;
};

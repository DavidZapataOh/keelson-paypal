import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The custom font sizes of globals.css, so `text-ui` is not merged away as a text color.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["ui", "amount"] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

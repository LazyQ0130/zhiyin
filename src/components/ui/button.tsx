import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ButtonHTMLAttributes } from "react";

const variants = cva("button", {
  variants: {
    variant: { primary: "button-primary", secondary: "button-secondary", ghost: "button-ghost", danger: "button-danger" },
    size: { default: "", small: "button-small", icon: "button-icon" },
  },
  defaultVariants: { variant: "primary", size: "default" },
});
export function Button({ className, variant, size, asChild, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={twMerge(clsx(variants({ variant, size }), className))} {...props} />;
}

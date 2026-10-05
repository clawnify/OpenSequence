import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command";

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A dropdown: a Popover holding a Command list, with a search box once the list
 * is longer than a handful. The trigger reads like a field.
 */
export function Picker({
  options, value, onChange, placeholder = "Choose…", searchPlaceholder = "Search…", id, disabled, className, label,
}: {
  options: PickerOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  /** For screen readers when no visible label points at it. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={cn(
            "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-sm bg-card px-3 text-left text-sm shadow-edge focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className={cn("truncate", !current && "text-faint")}>{current?.label ?? placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[14rem]">
        <Command>
          {options.length > 7 && <CommandInput placeholder={searchPlaceholder} />}
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={`${o.label} ${o.value}`}
                onSelect={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <Check className={cn("size-3.5 shrink-0", o.value === value ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-[0.75rem] text-muted-foreground">{o.hint}</span>}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

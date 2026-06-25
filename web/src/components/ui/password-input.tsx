"use client";

import { useState } from "react";
import { Eye, EyeOff } from "./icons";
import { inputCls } from "./styles";

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /** Clases extra para el <input> (se suman a inputCls). */
  className?: string;
};

/**
 * Campo de contraseña con botón "ojito" para mostrar/ocultar. Reemplaza a
 * <input type="password"> en login, alta de usuarios, etc. El toggle es local
 * (no se persiste). Deja padding a la derecha para no tapar el texto con el ícono.
 */
export function PasswordInput({ className = "", ...props }: PasswordInputProps) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={show ? "text" : "password"}
        className={`${inputCls} pr-10 ${className}`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
        aria-pressed={show}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-neutral-400 transition-colors hover:text-neutral-700"
      >
        {show ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}

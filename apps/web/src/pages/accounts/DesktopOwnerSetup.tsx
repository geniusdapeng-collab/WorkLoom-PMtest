import { useState, type FormEvent } from "react";
import { Button } from "@workloom/ui";
import { PRODUCT_NAME } from "../../lib/product";
import type { DesktopSetupBridge, DesktopSetupInput } from "./desktopSetup";

type SetupResult = Exclude<Awaited<ReturnType<DesktopSetupBridge["create"]>>, { error: string }>;

export default function DesktopOwnerSetup({ bridge, onCreated, onUnavailable }: {
  bridge: DesktopSetupBridge;
  onCreated: (result: SetupResult) => void;
  onUnavailable: () => void;
}) {
  const [input, setInput] = useState<DesktopSetupInput>({
    displayName: "", tenantName: "", workspaceName: "", email: "", password: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.create(input);
      if ("error" in result) {
        if (result.error === "SETUP_UNAVAILABLE") onUnavailable();
        else if (result.error === "EMAIL_IN_USE") setError("此邮箱已关联现有账号，请使用其他邮箱。");
        else setError(result.error === "INVALID_INPUT" ? "请检查表单。密码至少需要 12 个字符。" : "暂时无法创建工作区，请重试。");
        return;
      }
      onCreated(result);
    } catch {
      setError("无法连接本机服务，请重试。");
    } finally {
      setBusy(false);
    }
  }

  const fields = [
    { key: "displayName", label: "姓名", type: "text", autoComplete: "name", maxLength: 50 },
    { key: "tenantName", label: "企业名称", type: "text", autoComplete: "organization", maxLength: 100 },
    { key: "workspaceName", label: "工作区名称", type: "text", maxLength: 100 },
    { key: "email", label: "邮箱", type: "email", autoComplete: "email", maxLength: 254 },
    { key: "password", label: "密码", type: "password", autoComplete: "new-password", minLength: 12, maxLength: 128 },
  ] as const;
  const complete = input.displayName.trim() && input.tenantName.trim() && input.workspaceName.trim()
    && input.email.trim() && input.password.length >= 12;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-center px-4 py-10 sm:px-6">
      <h1 className="mb-1 break-words text-2xl font-bold">创建 {PRODUCT_NAME} 工作区</h1>
      <p className="mb-6 text-body text-neutral-300">创建本机工作区和管理员账号。之后使用此邮箱和密码登录。</p>
      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        {fields.map(({ key, label, ...properties }) => (
          <div key={key} className="text-body text-neutral-200">
            <label htmlFor={`owner-${key}`}>{label}</label>
            <input {...properties} id={`owner-${key}`} value={input[key]} disabled={busy} required
              aria-describedby={key === "password" ? "owner-password-requirement" : undefined}
              className="mt-1 min-h-11 w-full rounded-lg border border-neutral-600 bg-neutral-900 px-3 text-neutral-100 focus:border-blue-400 focus:outline-none"
              onChange={(event) => setInput((current) => ({ ...current, [key]: event.target.value }))} />
            {key === "password" && <p id="owner-password-requirement" className="mt-1 text-neutral-300">至少 12 个字符。</p>}
          </div>
        ))}
        {error && <p role="alert" className="break-words text-body text-red-300">{error}</p>}
        <Button type="submit" className="w-full" variant="primary" disabled={!complete} busy={busy} busyLabel="正在创建…">创建工作区</Button>
      </form>
    </main>
  );
}

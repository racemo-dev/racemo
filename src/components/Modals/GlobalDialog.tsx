import { useEffect } from "react";
import { useDialogStore } from "../../stores/dialogStore";
import { Info, Warning, WarningOctagon, CheckCircle, X } from "@phosphor-icons/react";
import { BrowserHideGuard } from "../Editor/BrowserViewer";

export default function GlobalDialog() {
    const {
        isOpen,
        title,
        message,
        type,
        confirmLabel,
        cancelLabel,
        onConfirm,
        onCancel,
        hide
    } = useDialogStore();

    useEffect(() => {
        // 단축키 핸들러 (Esc: 닫기, Enter: 확인)
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isOpen) return;
            if (e.key === "Escape") {
                hide();
                if (onCancel) onCancel();
            }
            if (e.key === "Enter") {
                hide();
                if (onConfirm) onConfirm();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, hide, onConfirm, onCancel]);

    if (!isOpen) return null;

    // 타입에 따른 아이콘 반환
    const getIcon = () => {
        switch (type) {
            case "error": return <WarningOctagon size={24} weight="regular" className="text-red-500" />;
            case "warning": return <Warning size={24} weight="regular" className="text-amber-500" />;
            case "success": return <CheckCircle size={24} weight="regular" className="text-green-500" />;
            default: return <Info size={24} weight="regular" className="text-blue-500" />;
        }
    };

    // 타입에 따른 강조 색상 반환
    const getTypeColor = () => {
        switch (type) {
            case "error": return "var(--accent-red)";
            case "warning": return "var(--accent-orange)";
            case "success": return "var(--accent-green)";
            default: return "var(--accent-blue)";
        }
    };

    return (
        <>
        <BrowserHideGuard />
        <div

            className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200"
            style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
            onClick={(e) => {
                if (e.target === e.currentTarget) {
                    hide();
                    if (onCancel) onCancel();
                }
            }}
        >
            <div
                className="w-full max-w-sm rounded-[12px] overflow-hidden animate-in zoom-in-95 duration-200"
                style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.2)"
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-5">
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 shrink-0">
                            {getIcon()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="text-[15px] font-semibold leading-6 truncate" style={{ color: "var(--text-primary)" }}>
                                {title}
                            </h3>
                            <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
                                {message}
                            </p>
                        </div>
                        <button
                            onClick={() => { hide(); if (onCancel) onCancel(); }}
                            className="shrink-0 p-1 rounded-md opacity-40 hover:opacity-100 transition-opacity"
                            style={{ color: "var(--text-muted)" }}
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                <div className="px-5 py-3.5 flex justify-end gap-2.5 border-t" style={{ borderColor: "var(--border-default)" }}>
                    {cancelLabel && (
                        <button
                            onClick={() => { hide(); if (onCancel) onCancel(); }}
                            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-all"
                            style={{
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border-default)",
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = "var(--bg-overlay)";
                                e.currentTarget.style.borderColor = "var(--border-active)";
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = "transparent";
                                e.currentTarget.style.borderColor = "var(--border-default)";
                            }}
                        >
                            {cancelLabel}
                        </button>
                    )}
                    <button
                        onClick={() => { hide(); if (onConfirm) onConfirm(); }}
                        className="px-5 py-1.5 rounded-lg text-xs font-semibold transition-all"
                        style={{
                            color: getTypeColor(),
                            border: `1px solid ${getTypeColor()}`,
                            backgroundColor: "transparent"
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = `${getTypeColor()}15`;
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "transparent";
                        }}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
        </>
    );
}

import { create } from "zustand";

// 다이얼로그 타입: 정보, 에러, 경고, 성공
export type DialogType = "info" | "error" | "warning" | "success";

interface DialogState {
    isOpen: boolean;
    title: string;
    message: string;
    type: DialogType;
    confirmLabel: string;
    cancelLabel: string | null;
    onConfirm: (() => void) | null;
    onCancel: (() => void) | null;

    // 다이얼로그 표시 함수
    show: (options: {
        title: string;
        message: string;
        type?: DialogType;
        confirmLabel?: string;
        cancelLabel?: string;
        onConfirm?: () => void;
        onCancel?: () => void;
    }) => void;
    // 다이얼로그 숨기기 함수
    hide: () => void;
}

export const useDialogStore = create<DialogState>((set) => ({
    isOpen: false,
    title: "",
    message: "",
    type: "info",
    confirmLabel: "Confirm",
    cancelLabel: null,
    onConfirm: null,
    onCancel: null,

    show: (options) =>
        set({
            isOpen: true,
            title: options.title,
            message: options.message,
            type: options.type || "info",
            confirmLabel: options.confirmLabel || "Confirm",
            cancelLabel: options.cancelLabel || null,
            onConfirm: options.onConfirm || null,
            onCancel: options.onCancel || null,
        }),

    hide: () =>
        set({
            isOpen: false,
            title: "",
            message: "",
            onConfirm: null,
            onCancel: null,
        }),
}));

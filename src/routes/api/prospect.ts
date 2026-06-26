import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Input = z.object({
  municipio: z.string().min(1),
  uf: z.string().length(2),
  ibgeId: z.number().int().positive().optional(),
  useDiario: z.boolean().optional().default(false),
});


export const Route = createFileRoute("/api/prospect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        const parsed = Input.safeParse(body);
        if (!parsed.success) {
          return new Response(JSON.stringify(parsed.error.flatten()), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const { municipio, uf, ibgeId, useDiario } = parsed.data;

        const { prospectar } = await import("@/lib/prospect.server");
        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (obj: unknown) => {
              controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
            };
            try {
              await prospectar(municipio, uf, (evt) => send(evt), ibgeId, { useDiario });

            } catch (e) {
              send({
                kind: "progress",
                level: "error",
                etapa: "final",
                message: "Falha inesperada na prospecção",
                data: String(e),
                ts: Date.now(),
              });
              send({
                kind: "final",
                result: {
                  status: "not_found",
                  hierarquia: null,
                  secretario: null,
                  cargo: null,
                  emails: [],
                  telefones: [],
                  fonte: null,
                  fonteUrl: null,
                  contexto: e instanceof Error ? e.message : "Erro desconhecido",
                },
                ts: Date.now(),
              });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});

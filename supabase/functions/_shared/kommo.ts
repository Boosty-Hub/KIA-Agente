// _shared/kommo.ts
// Helpers reutilizables para interactuar con la API de Kommo CRM.
// Copiados verbatim de publish-to-kommo/index.ts para evitar duplicación.
//
// Uso:
//   import { patchLeadField, runSalesbot } from "../_shared/kommo.ts";

/**
 * Actualiza un custom field de un lead en Kommo.
 * Throws si la respuesta no es OK.
 */
export async function patchLeadField(
  kommoLeadId: number,
  fieldId: number,
  value: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [
        {
          field_id: fieldId,
          values: [{ value }],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch lead: ${res.status} ${await res.text()}`);
  }
}

/**
 * Actualiza un custom field de un CONTACTO en Kommo (mismo shape que el lead,
 * pero el endpoint apunta a /contacts/). Throws si la respuesta no es OK.
 */
export async function patchContactField(
  kommoContactId: number,
  fieldId: number,
  value: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/contacts/${kommoContactId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [
        {
          field_id: fieldId,
          values: [{ value }],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch contact: ${res.status} ${await res.text()}`);
  }
}

/**
 * Mueve un lead a otra etapa (status_id) de Kommo, opcionalmente cambiando de
 * pipeline. Throws si la respuesta no es OK.
 */
export async function moveLeadStage(
  kommoLeadId: number,
  statusId: number,
  pipelineId: number | null,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const body: Record<string, unknown> = { status_id: statusId };
  if (pipelineId != null) body.pipeline_id = pipelineId;
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`move lead stage: ${res.status} ${await res.text()}`);
  }
}

// Status IDs reservados/universales de Kommo: 142 = GANADO (won), 143 = PERDIDO
// (lost). Existen en TODOS los pipelines. Un lead en cualquiera de estas etapas
// es terminal y nunca debe recibir seguimiento.
export const KOMMO_WON_STATUS = 142;
export const KOMMO_LOST_STATUS = 143;

/**
 * Trae el snapshot EN VIVO de un lead desde Kommo: etapa (status_id +
 * pipeline_id) y responsable asignado (responsible_user_id). Fuente de verdad
 * autoritativa — a diferencia del cache local `kommo_stage_id`, que solo se
 * refresca con inbounds y movimientos del agente. Throws si !OK.
 */
export async function fetchLeadStage(
  kommoLeadId: number,
  kommoDomain: string,
  kommoToken: string
): Promise<{ statusId: number; pipelineId: number; responsibleUserId: number | null }> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (!res.ok) {
    throw new Error(`fetch lead stage: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    status_id?: number;
    pipeline_id?: number;
    responsible_user_id?: number;
  };
  const ruid = json.responsible_user_id;
  return {
    statusId: Number(json.status_id),
    pipelineId: Number(json.pipeline_id),
    responsibleUserId: ruid == null ? null : Number(ruid),
  };
}

export type KommoStageLite = {
  id: number;
  name: string;
  pipelineId: number;
  pipelineName: string;
};

/**
 * Trae TODAS las etapas (status) de todos los pipelines de Kommo, aplanadas,
 * para resolver una etapa POR NOMBRE → status_id + pipeline_id.
 */
export async function fetchPipelineStages(
  kommoDomain: string,
  kommoToken: string
): Promise<KommoStageLite[]> {
  const url = `https://${kommoDomain}/api/v4/leads/pipelines`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (!res.ok) {
    throw new Error(`fetch pipelines: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: {
      pipelines?: Array<{
        id: number;
        name: string;
        _embedded?: { statuses?: Array<{ id: number; name: string }> };
      }>;
    };
  };
  const out: KommoStageLite[] = [];
  for (const p of json._embedded?.pipelines ?? []) {
    for (const s of p._embedded?.statuses ?? []) {
      out.push({ id: s.id, name: s.name, pipelineId: p.id, pipelineName: p.name });
    }
  }
  return out;
}

export type KommoFieldLite = {
  id: number;
  name: string;
  code: string | null; // PHONE/EMAIL/... en campos de sistema; null si es custom
  type: string | null; // text/numeric/select/multiselect/checkbox/...
  enums: Array<{ id: number; value: string }>; // opciones de select/multiselect
};

/**
 * Trae los custom fields de leads o contacts de Kommo para resolver un campo
 * POR NOMBRE → field_id (+ tipo, código de sistema y opciones de lista).
 * 204 = sin campos.
 */
export async function fetchEntityFields(
  entity: "leads" | "contacts",
  kommoDomain: string,
  kommoToken: string
): Promise<KommoFieldLite[]> {
  const url = `https://${kommoDomain}/api/v4/${entity}/custom_fields?limit=250`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`fetch ${entity} fields: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: {
      custom_fields?: Array<{
        id: number;
        name: string;
        code?: string | null;
        type?: string | null;
        enums?: Array<{ id: number; value: string }> | null;
      }>;
    };
  };
  return (json._embedded?.custom_fields ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    code: f.code ?? null,
    type: f.type ?? null,
    enums: (f.enums ?? []).map((e) => ({ id: e.id, value: e.value })),
  }));
}

/**
 * Dispara un salesbot de Kommo sobre un lead.
 * Endpoint legacy v2 (sigue soportado en cuentas v4).
 * Throws si la respuesta no es OK.
 */
export async function runSalesbot(
  botId: number,
  kommoLeadId: number,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v2/salesbot/run`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        bot_id: botId,
        entity_id: kommoLeadId,
        entity_type: 2, // 2 = lead
      },
    ]),
  });
  if (!res.ok) {
    throw new Error(`run salesbot: ${res.status} ${await res.text()}`);
  }
}

/**
 * Agrega una nota interna (note_type "common") al lead en Kommo. Throws si !OK.
 */
export async function addLeadNote(
  kommoLeadId: number,
  text: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}/notes`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ note_type: "common", params: { text } }]),
  });
  if (!res.ok) {
    throw new Error(`add lead note: ${res.status} ${await res.text()}`);
  }
}

/**
 * Enciende/apaga un campo custom tipo casilla (checkbox) de un lead. Kommo espera
 * el valor booleano. Útil para el kill-switch "Apagar Agente". Throws si !OK.
 */
export async function setLeadCheckboxField(
  kommoLeadId: number,
  fieldId: number,
  checked: boolean,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [{ field_id: fieldId, values: [{ value: checked }] }],
    }),
  });
  if (!res.ok) {
    throw new Error(`set lead checkbox: ${res.status} ${await res.text()}`);
  }
}

/**
 * Setea un campo tipo lista (select/multiselect) de un lead o contacto por
 * enum_id (uno para select, varios para multiselect). Throws si !OK.
 */
export async function patchEntityFieldEnum(
  entity: "leads" | "contacts",
  entityId: number,
  fieldId: number,
  enumIds: number[],
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/${entity}/${entityId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [
        { field_id: fieldId, values: enumIds.map((id) => ({ enum_id: id })) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch ${entity} enum field: ${res.status} ${await res.text()}`);
  }
}

/**
 * Setea un campo de SISTEMA del contacto (teléfono/email) por field_code. Estos
 * campos usan un shape distinto: { field_code, values:[{ value, enum_code }] }.
 * enumCode típico: "WORK". Throws si !OK.
 */
export async function patchContactCodeField(
  kommoContactId: number,
  fieldCode: string,
  value: string,
  enumCode: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/contacts/${kommoContactId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [
        { field_code: fieldCode, values: [{ value, enum_code: enumCode }] },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch contact code field: ${res.status} ${await res.text()}`);
  }
}

/**
 * Agrega etiquetas (tags) a un lead de forma ADITIVA: lee las existentes y hace
 * PATCH con la unión (Kommo reemplaza el set completo en _embedded.tags).
 * No-op si todas ya existen. Throws si !OK.
 */
export async function addLeadTags(
  kommoLeadId: number,
  names: string[],
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const base = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const getRes = await fetch(base, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (!getRes.ok) {
    throw new Error(`add lead tags (get): ${getRes.status} ${await getRes.text()}`);
  }
  const lead = (await getRes.json()) as {
    _embedded?: { tags?: Array<{ id: number; name: string }> };
  };
  const existing = lead._embedded?.tags ?? [];
  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));
  const toAdd = names
    .map((n) => n.trim())
    .filter((n) => n && !existingNames.has(n.toLowerCase()));
  if (toAdd.length === 0) return;
  const tags = [
    ...existing.map((t) => ({ id: t.id })),
    ...toAdd.map((name) => ({ name })),
  ];
  const patchRes = await fetch(base, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ _embedded: { tags } }),
  });
  if (!patchRes.ok) {
    throw new Error(`add lead tags (patch): ${patchRes.status} ${await patchRes.text()}`);
  }
}

import { useState, type FormEvent } from 'react';
import { Backpack, Minus, Plus, Trash2 } from 'lucide-react';
import type { InventoryCategory, InventoryItem } from '../types/game';
import { INVENTORY_CATEGORY_LABELS } from '../engine/constants';
import type { InventoryMutationCommand } from '../engine/rulesEngine';

interface InventoryPanelProps {
  items: InventoryItem[];
  isArchived: boolean;
  isMutating: boolean;
  readOnly?: boolean;
  onMutateInventory: (command: InventoryMutationCommand) => Promise<boolean>;
}

export function InventoryPanel({
  items,
  isArchived,
  isMutating,
  readOnly,
  onMutateInventory,
}: InventoryPanelProps) {
  const [filter, setFilter] = useState<'todos' | InventoryCategory>('todos');
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<InventoryCategory>('recurso');
  const [quantity, setQuantity] = useState('1');
  const [description, setDescription] = useState('');
  const [equipable, setEquipable] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const filteredItems =
    filter === 'todos' ? items : items.filter((item) => item.category === filter);

  const handleAddSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const parsedQty = Number(quantity);

    if (!Number.isInteger(parsedQty) || parsedQty < 1) {
      setLocalError('Informe uma quantidade inteira positiva (mínimo 1).');
      return;
    }

    const ok = await onMutateInventory({
      kind: 'add',
      name,
      category,
      quantity: parsedQty,
      description,
      equipable,
    });

    if (ok) {
      setName('');
      setQuantity('1');
      setDescription('');
      setEquipable(false);
      setShowAddForm(false);
    }
  };

  return (
    <section aria-labelledby="inventory-heading" className="space-y-4 border-t border-white/8 pt-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Backpack className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
          <h2
            id="inventory-heading"
            className="font-display text-base font-semibold text-[#F2E2B0] tracking-wide"
          >
            Inventário
          </h2>
          <span className="font-mono-tabular text-xs text-[#9CA3AF]">
            ({items.length})
          </span>
        </div>

        {!readOnly && <button
          type="button"
          disabled={isArchived || isMutating}
          onClick={() => {
            setLocalError(null);
            setShowAddForm((prev) => !prev);
          }}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-[#D4AF37]/30 text-[#F2E2B0] hover:bg-[#D4AF37]/10 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {showAddForm ? 'Cancelar' : 'Adicionar Item'}
        </button>}
      </div>

      {readOnly && <p className="text-xs text-[#9CA3AF]">Pegue, largue e entregue objetos pelo campo de ação.</p>}

      {/* Filtro funcional por categoria */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {(
          [
            { id: 'todos', label: 'Todos' },
            { id: 'equipamento', label: 'Equip.' },
            { id: 'consumivel', label: 'Consum.' },
            { id: 'documento', label: 'Doc.' },
            { id: 'recurso', label: 'Recurso' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              filter === tab.id
                ? 'bg-[#D4AF37]/20 text-[#F2E2B0] font-medium'
                : 'text-[#9CA3AF] hover:text-[#EDE8DC]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {showAddForm && !readOnly && (
        <form
          onSubmit={handleAddSubmit}
          className="bg-[#0E121A] border border-[#D4AF37]/25 rounded-lg p-3.5 space-y-3"
        >
          <p className="text-xs font-semibold text-[#F2E2B0]">Novo Item Estruturado</p>

          {localError && (
            <p className="text-xs text-red-400" role="alert">
              {localError}
            </p>
          )}

          <div className="space-y-1">
            <label htmlFor="item-name" className="block text-xs text-[#B7B2A6]">
              Nome do item
            </label>
            <input
              id="item-name"
              type="text"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Erva de Freixo"
              className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor="item-category" className="block text-xs text-[#B7B2A6]">
                Categoria
              </label>
              <select
                id="item-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as InventoryCategory)}
                className="w-full px-2.5 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
              >
                {Object.entries(INVENTORY_CATEGORY_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="item-qty" className="block text-xs text-[#B7B2A6]">
                Quantidade
              </label>
              <input
                id="item-qty"
                type="number"
                min={1}
                max={99999}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono-tabular rounded bg-[#141924] border border-white/10 text-[#EDE8DC] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="item-desc" className="block text-xs text-[#B7B2A6]">
              Descrição
            </label>
            <input
              id="item-desc"
              type="text"
              maxLength={240}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Finalidade ou observação objetiva"
              className="w-full px-3 py-2 text-xs rounded bg-[#141924] border border-white/10 text-[#EDE8DC] placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-[#C8C3B8] cursor-pointer">
            <input
              type="checkbox"
              checked={equipable}
              onChange={(e) => setEquipable(e.target.checked)}
              className="accent-[#D4AF37]"
            />
            Item equipável por Samuel
          </label>

          <button
            type="submit"
            disabled={isMutating}
            className="w-full py-2 text-xs font-semibold rounded bg-[#D4AF37] text-[#0B0D12] hover:bg-[#E2C258] disabled:opacity-50 transition-colors cursor-pointer"
          >
            Confirmar e Salvar Item
          </button>
        </form>
      )}

      {filteredItems.length === 0 ? (
        <div className="py-6 text-center space-y-2 border border-dashed border-white/10 rounded-lg px-4">
          <p className="text-xs text-[#9CA3AF]">
            {items.length === 0
              ? 'Nenhum item no inventário ainda.'
              : 'Nenhum item nesta categoria.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-white/8">
          {filteredItems.map((item) => (
            <li key={item.id} className="py-3 first:pt-1 last:pb-0 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#EDE8DC] break-words">
                    {item.name}
                  </p>
                  <p className="text-xs text-[#9CA3AF]">
                    {INVENTORY_CATEGORY_LABELS[item.category]}
                    {item.equipable ? (item.equipped ? ' · Equipado' : ' · Guardado') : ''}
                  </p>
                </div>

                <span className="font-mono-tabular text-sm font-semibold text-[#F2E2B0] shrink-0">
                  {item.quantity}x
                </span>
              </div>

              {item.description && (
                <p className="text-xs text-[#B7B2A6] leading-relaxed">{item.description}</p>
              )}

              {!readOnly && <div className="flex items-center justify-between gap-2 pt-0.5">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={isArchived || isMutating}
                    onClick={() =>
                      void onMutateInventory({
                        kind: 'set_quantity',
                        itemId: item.id,
                        quantity: item.quantity - 1,
                      })
                    }
                    aria-label={`Diminuir quantidade de ${item.name}`}
                    className="w-8 h-8 flex items-center justify-center rounded bg-[#0E121A] border border-white/10 hover:border-[#D4AF37]/40 text-[#C8C3B8] disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Minus className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={isArchived || isMutating}
                    onClick={() =>
                      void onMutateInventory({
                        kind: 'set_quantity',
                        itemId: item.id,
                        quantity: item.quantity + 1,
                      })
                    }
                    aria-label={`Aumentar quantidade de ${item.name}`}
                    className="w-8 h-8 flex items-center justify-center rounded bg-[#0E121A] border border-white/10 hover:border-[#D4AF37]/40 text-[#F2E2B0] disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  {item.equipable && (
                    <button
                      type="button"
                      disabled={isArchived || isMutating}
                      onClick={() =>
                        void onMutateInventory({
                          kind: 'toggle_equipped',
                          itemId: item.id,
                        })
                      }
                      className="px-2.5 h-8 text-xs rounded bg-[#0E121A] border border-white/10 hover:border-[#D4AF37]/40 text-[#EDE8DC] disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {item.equipped ? 'Desequipar' : 'Equipar'}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  disabled={isArchived || isMutating}
                  onClick={() =>
                    void onMutateInventory({
                      kind: 'remove',
                      itemId: item.id,
                    })
                  }
                  aria-label={`Remover ${item.name}`}
                  className="w-8 h-8 flex items-center justify-center rounded text-[#9CA3AF] hover:text-red-400 hover:bg-red-950/40 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

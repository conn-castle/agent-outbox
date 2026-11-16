"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import {
  restrictToParentElement,
  restrictToVerticalAxis
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ChevronDown,
  Filter,
  GripVertical,
  Plus,
  RotateCcw,
  X
} from "lucide-react";

import {
  defaultHumanReviewSortDirection,
  isDefaultHumanReviewOrdering,
  type HumanReviewSort,
  type HumanReviewSortDirection,
  type HumanReviewView
} from "../../shared/human-review-view";
import { compareHumanReviewTypeNames } from "../../shared/human-review-sort";

// The review queue's filter and sort controls, and how a view is described.

const SORT_OPTIONS = [
  { value: "priority", label: "Priority" },
  { value: "type", label: "Type" },
  { value: "visual_score", label: "Visual score" },
  { value: "title", label: "Title" },
  { value: "caller", label: "Caller" },
  { value: "card_time", label: "Card time" },
  { value: "created_at", label: "Created" },
  { value: "updated_at", label: "Last updated" }
] as const;

const PRIORITY_FILTER_OPTIONS = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" }
] as const;

export function ReviewViewControls({
  view,
  typeOptions,
  workspaceRef,
  onChange
}: {
  view: HumanReviewView;
  typeOptions: string[];
  workspaceRef: RefObject<HTMLElement | null>;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  const [openViewControl, setOpenViewControl] = useState<
    "filter" | "sort" | null
  >(null);
  const [useViewControlSheet, setUseViewControlSheet] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const synchronize = () => setUseViewControlSheet(query.matches);
    synchronize();
    query.addEventListener("change", synchronize);
    return () => query.removeEventListener("change", synchronize);
  }, []);

  useEffect(() => {
    if (openViewControl === null) return;
    const closeViewControl = () => {
      const trigger = document.querySelector<HTMLElement>(
        `[data-view-popover-trigger="${openViewControl}"]`
      );
      setOpenViewControl(null);
      return trigger;
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "[data-view-popover-control], [data-view-popover-surface]"
        )
      ) {
        return;
      }
      closeViewControl();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeViewControl()?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openViewControl]);

  return (
    <div className="filter-controls">
      <ReviewFilterControl
        view={view}
        typeOptions={typeOptions}
        open={openViewControl === "filter"}
        sheet={useViewControlSheet}
        portalTarget={workspaceRef.current}
        onOpenChange={(open) => setOpenViewControl(open ? "filter" : null)}
        onChange={onChange}
      />
      <ReviewSortControl
        view={view}
        open={openViewControl === "sort"}
        sheet={useViewControlSheet}
        portalTarget={workspaceRef.current}
        onOpenChange={(open) => setOpenViewControl(open ? "sort" : null)}
        onChange={onChange}
      />
    </div>
  );
}

function ViewPopoverLayer({
  open,
  sheet,
  portalTarget,
  closeLabel,
  onClose,
  children
}: {
  open: boolean;
  sheet: boolean;
  portalTarget: HTMLElement | null;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  const layer = (
    <>
      {sheet ? (
        <button
          type="button"
          className="view-popover-scrim"
          aria-label={closeLabel}
          onClick={onClose}
        />
      ) : null}
      {children}
    </>
  );
  return sheet && portalTarget ? createPortal(layer, portalTarget) : layer;
}

function ReviewFilterControl({
  view,
  typeOptions,
  open,
  sheet,
  portalTarget,
  onOpenChange,
  onChange
}: {
  view: HumanReviewView;
  typeOptions: string[];
  open: boolean;
  sheet: boolean;
  portalTarget: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const count = view.priorities.length + view.types.length;
  const availableTypes = [...new Set([...typeOptions, ...view.types])].sort(
    compareHumanReviewTypeNames
  );
  useEffect(() => {
    if (open) popoverRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [open]);
  return (
    <div
      className={`view-control${count ? " active" : ""}${open ? " open" : ""}`}
      data-view-popover-control
    >
      <button
        type="button"
        className="view-control-trigger"
        aria-label={`Filter${count ? `, ${count} applied` : ""}`}
        aria-expanded={open}
        aria-controls="review-filter-popover"
        aria-haspopup="dialog"
        data-view-popover-trigger="filter"
        onClick={() => onOpenChange(!open)}
      >
        <Filter aria-hidden="true" />
        <span>Filter</span>
        {count ? <strong className="view-control-count">{count}</strong> : null}
        <ChevronDown aria-hidden="true" />
      </button>
      <ViewPopoverLayer
        open={open}
        sheet={sheet}
        portalTarget={portalTarget}
        closeLabel="Dismiss filter panel"
        onClose={() => onOpenChange(false)}
      >
        <div
          ref={popoverRef}
          id="review-filter-popover"
          className="view-popover filter-popover"
          role="dialog"
          aria-label="Filter reviews"
          data-view-popover-surface
        >
          <div className="view-popover-heading">
            <div>
              <strong>Filter reviews</strong>
              <span>Select any values you want to include.</span>
            </div>
            <div className="view-popover-actions">
              {count ? (
                <button
                  type="button"
                  className="view-reset-button"
                  onClick={() => onChange({ priorities: [], types: [] })}
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="sort-icon-button view-close-button"
                aria-label="Close filter menu"
                onClick={() => onOpenChange(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          <FilterChoices
            legend="Priority"
            options={PRIORITY_FILTER_OPTIONS}
            selected={view.priorities}
            onChange={(priorities) =>
              onChange({
                priorities: priorities as HumanReviewView["priorities"]
              })
            }
          />
          <FilterChoices
            legend="Type"
            options={availableTypes.map((value) => ({ value, label: value }))}
            selected={view.types}
            emptyCopy="No review types in this view."
            onChange={(types) => onChange({ types })}
          />
          <div className="view-popover-footer">
            <button type="button" onClick={() => onOpenChange(false)}>
              Done
            </button>
          </div>
        </div>
      </ViewPopoverLayer>
    </div>
  );
}

function FilterChoices({
  legend,
  options,
  selected,
  emptyCopy,
  onChange
}: {
  legend: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: readonly string[];
  emptyCopy?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="filter-choice-group">
      <legend>{legend}</legend>
      {options.length ? (
        <div className="filter-choice-list">
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value)
                  )
                }
              />
              <span>{option.label}</span>
              {selected.includes(option.value) ? (
                <Check aria-hidden="true" />
              ) : null}
            </label>
          ))}
        </div>
      ) : (
        <p className="filter-empty-copy">{emptyCopy}</p>
      )}
    </fieldset>
  );
}

function ReviewSortControl({
  view,
  open,
  sheet,
  portalTarget,
  onOpenChange,
  onChange
}: {
  view: HumanReviewView;
  open: boolean;
  sheet: boolean;
  portalTarget: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousRuleCount = useRef(view.sorts.length);
  const focusRuleAfterFieldChange = useRef<number | null>(null);
  const recipe = view.sorts.map(({ key }) => sortLabel(key)).join(" → ");
  const custom = !isDefaultHumanReviewOrdering(view);
  const unusedSort = SORT_OPTIONS.find(
    (option) => !view.sorts.some((rule) => rule.key === option.value)
  )?.value;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  function moveRule(from: number, to: number) {
    if (to < 0 || to >= view.sorts.length || from === to) return;
    onChange({ sorts: arrayMove(view.sorts, from, to) });
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const from = view.sorts.findIndex((rule) => rule.key === event.active.id);
    const to = view.sorts.findIndex((rule) => rule.key === event.over?.id);
    if (from >= 0 && to >= 0) moveRule(from, to);
  }

  function closeAndRestoreFocus() {
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (open) popoverRef.current?.querySelector<HTMLElement>("select")?.focus();
  }, [open]);
  useEffect(() => {
    const previous = previousRuleCount.current;
    previousRuleCount.current = view.sorts.length;
    if (!open || view.sorts.length <= previous) return;
    popoverRef.current
      ?.querySelector<HTMLElement>(
        `[aria-label="Sort ${view.sorts.length} field"]`
      )
      ?.focus();
  }, [open, view.sorts.length]);
  useEffect(() => {
    const rank = focusRuleAfterFieldChange.current;
    if (!open || rank === null) return;
    focusRuleAfterFieldChange.current = null;
    popoverRef.current
      ?.querySelector<HTMLElement>(`[aria-label="Sort ${rank} field"]`)
      ?.focus();
  }, [open, view.sorts]);

  return (
    <div
      className={`view-control sort-control${custom ? " active" : ""}${open ? " open" : ""}`}
      data-view-popover-control
    >
      <button
        ref={triggerRef}
        type="button"
        className="view-control-trigger"
        aria-label={`Sort: ${recipe}`}
        aria-expanded={open}
        aria-controls="review-sort-popover"
        aria-haspopup="dialog"
        data-view-popover-trigger="sort"
        onClick={() => onOpenChange(!open)}
      >
        <span>Sort</span>
        <strong>{recipe}</strong>
        <ChevronDown aria-hidden="true" />
      </button>
      <ViewPopoverLayer
        open={open}
        sheet={sheet}
        portalTarget={portalTarget}
        closeLabel="Dismiss sort panel"
        onClose={closeAndRestoreFocus}
      >
        <div
          ref={popoverRef}
          id="review-sort-popover"
          className="view-popover sort-popover"
          role="dialog"
          aria-label="Sort reviews"
          data-view-popover-surface
        >
          <div className="view-popover-heading">
            <div>
              <strong>Sort order</strong>
              <span>
                {view.sorts.length > 1
                  ? "Drag rules into priority order."
                  : "Choose how the queue should be ordered."}
              </span>
            </div>
            <div className="view-popover-actions">
              {custom ? (
                <button
                  type="button"
                  className="view-reset-button"
                  onClick={() =>
                    onChange({ sorts: [{ key: "priority", direction: "asc" }] })
                  }
                >
                  <RotateCcw aria-hidden="true" /> Reset
                </button>
              ) : null}
              <button
                type="button"
                className="sort-done-button"
                onClick={closeAndRestoreFocus}
              >
                Done
              </button>
            </div>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "Drag to reorder with a pointer, or use Arrow Up and Arrow Down while this handle is focused."
              },
              announcements: {
                onDragStart: ({ active }) =>
                  `Picked up ${sortLabel(active.id as HumanReviewSort)} sort.`,
                onDragOver: ({ active, over }) =>
                  over
                    ? `${sortLabel(active.id as HumanReviewSort)} is over ${sortLabel(over.id as HumanReviewSort)}.`
                    : undefined,
                onDragEnd: ({ active, over }) =>
                  over
                    ? `Placed ${sortLabel(active.id as HumanReviewSort)} at ${sortLabel(over.id as HumanReviewSort)} position.`
                    : `Dropped ${sortLabel(active.id as HumanReviewSort)} without changing its position.`,
                onDragCancel: ({ active }) =>
                  `Cancelled moving ${sortLabel(active.id as HumanReviewSort)}.`
              }
            }}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={view.sorts.map((rule) => rule.key)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="sort-rule-list">
                {view.sorts.map((rule, index) => (
                  <SortRule
                    key={rule.key}
                    rank={index + 1}
                    total={view.sorts.length}
                    sort={rule.key}
                    direction={rule.direction}
                    excluded={view.sorts
                      .filter((_, ruleIndex) => ruleIndex !== index)
                      .map(({ key }) => key)}
                    onSortChange={(key) => {
                      focusRuleAfterFieldChange.current = index + 1;
                      const sorts = [...view.sorts];
                      sorts[index] = {
                        key,
                        direction: defaultHumanReviewSortDirection(key)
                      };
                      onChange({ sorts });
                    }}
                    onDirectionChange={(direction) => {
                      const sorts = [...view.sorts];
                      sorts[index] = { ...rule, direction };
                      onChange({ sorts });
                    }}
                    onMove={(offset) => moveRule(index, index + offset)}
                    onRemove={
                      view.sorts.length > 1
                        ? () =>
                            onChange({
                              sorts: view.sorts.filter(
                                (_, ruleIndex) => ruleIndex !== index
                              )
                            })
                        : undefined
                    }
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {unusedSort ? (
            <button
              type="button"
              className="add-sort-button"
              onClick={() =>
                onChange({
                  sorts: [
                    ...view.sorts,
                    {
                      key: unusedSort,
                      direction: defaultHumanReviewSortDirection(unusedSort)
                    }
                  ]
                })
              }
            >
              <Plus aria-hidden="true" /> Add sort field
            </button>
          ) : null}
          {view.sorts.some((rule) => rule.key === "visual_score") ? (
            <p className="sort-null-copy">
              <span aria-hidden="true">↓</span>
              Reviews without a numeric score stay at the bottom.
            </p>
          ) : null}
        </div>
      </ViewPopoverLayer>
    </div>
  );
}

function SortRule({
  rank,
  total,
  sort,
  direction,
  excluded,
  onSortChange,
  onDirectionChange,
  onMove,
  onRemove
}: {
  rank: number;
  total: number;
  sort: HumanReviewSort;
  direction: HumanReviewSortDirection;
  excluded: HumanReviewSort[];
  onSortChange: (sort: HumanReviewSort) => void;
  onDirectionChange: (direction: HumanReviewSortDirection) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging
  } = useSortable({ id: sort, disabled: total < 2 });
  const style = {
    "--sort-rule-transform": CSS.Transform.toString(transform) ?? "none"
  } as CSSProperties;

  return (
    <li
      ref={setNodeRef}
      className={`sort-rule${isDragging ? " dragging" : ""}`}
      style={style}
    >
      <div className="sort-rule-row">
        <span className="sort-rank" aria-hidden="true">
          {rank}
        </span>
        {total > 1 ? (
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="sort-drag-handle"
            aria-label={`Reorder ${sortLabel(sort)} sort, position ${rank} of ${total}`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            {...attributes}
            {...listeners}
            onKeyDown={(event) => {
              const offset =
                event.key === "ArrowUp"
                  ? -1
                  : event.key === "ArrowDown"
                    ? 1
                    : 0;
              if (!offset || rank + offset < 1 || rank + offset > total) return;
              event.preventDefault();
              onMove(offset);
            }}
          >
            <GripVertical aria-hidden="true" />
          </button>
        ) : (
          <span className="sort-drag-placeholder" aria-hidden="true" />
        )}
        <div className="sort-rule-fields">
          <SortSelect
            ariaLabel={`Sort ${rank} field`}
            value={sort}
            options={SORT_OPTIONS.filter(
              (option) => !excluded.includes(option.value)
            )}
            onChange={(value) => onSortChange(value as HumanReviewSort)}
          />
          <SortSelect
            className="sort-direction-select"
            ariaLabel={`Sort ${rank} direction`}
            value={direction}
            options={(["asc", "desc"] as const).map((value) => ({
              value,
              label: sortDirectionLabel(sort, value)
            }))}
            onChange={(value) =>
              onDirectionChange(value as HumanReviewSortDirection)
            }
          />
        </div>
        {onRemove ? (
          <button
            type="button"
            className="sort-remove-button"
            onClick={onRemove}
            aria-label={`Remove ${sortLabel(sort)} sort`}
          >
            <X aria-hidden="true" />
          </button>
        ) : (
          <span className="sort-remove-placeholder" aria-hidden="true" />
        )}
      </div>
    </li>
  );
}

function SortSelect({
  className,
  ariaLabel,
  value,
  options,
  onChange
}: {
  className?: string;
  ariaLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`sort-select${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{ariaLabel}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" />
    </label>
  );
}

export function ActiveFilterChips({
  view,
  onChange
}: {
  view: HumanReviewView;
  onChange: (changes: Partial<HumanReviewView>) => void;
}) {
  if (view.priorities.length === 0 && view.types.length === 0) return null;
  return (
    <div
      className="active-filter-chips"
      role="group"
      aria-label="Applied filters"
    >
      <span>Showing</span>
      {view.priorities.map((priority) => (
        <button
          key={priority}
          type="button"
          onClick={() =>
            onChange({
              priorities: view.priorities.filter((value) => value !== priority)
            })
          }
          aria-label={`Remove Priority: ${titleCase(priority)} filter`}
        >
          Priority: {titleCase(priority)} <X aria-hidden="true" />
        </button>
      ))}
      {view.types.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() =>
            onChange({ types: view.types.filter((value) => value !== type) })
          }
          aria-label={`Remove Type: ${type} filter`}
        >
          Type: {type} <X aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        className="clear-filter-chips"
        onClick={() => onChange({ priorities: [], types: [] })}
      >
        Clear all
      </button>
    </div>
  );
}

export function sortLabel(sort: HumanReviewSort) {
  return SORT_OPTIONS.find((option) => option.value === sort)?.label ?? sort;
}

export function sortDirectionLabel(
  sort: HumanReviewSort,
  direction: HumanReviewSortDirection
) {
  if (sort === "priority")
    return direction === "asc" ? "Urgent first" : "Low first";
  if (sort === "type" || sort === "title" || sort === "caller")
    return direction === "asc" ? "A–Z" : "Z–A";
  if (sort === "visual_score")
    return direction === "asc" ? "Low to high" : "High to low";
  return direction === "desc" ? "Newest first" : "Oldest first";
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

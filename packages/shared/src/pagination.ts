export interface PageParams {
  page: number;
  pageSize: number;
}

export interface PageMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export function normalizePageParams(input: Partial<PageParams> | undefined): PageParams {
  const page = Math.max(1, Math.floor(input?.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input?.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize };
}

export function toSkipTake(params: PageParams): { skip: number; take: number } {
  return { skip: (params.page - 1) * params.pageSize, take: params.pageSize };
}

export function paginate<T>(data: T[], total: number, params: PageParams): Paginated<T> {
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  return {
    data,
    meta: {
      total,
      page: params.page,
      pageSize: params.pageSize,
      totalPages,
      hasMore: params.page < totalPages,
    },
  };
}

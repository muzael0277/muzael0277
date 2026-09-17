import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCategorySchema, createProductSchema, updateProductSchema, listProductsSchema,
  createVariantSchema, createModifierGroupSchema, createServiceSchema, updateServiceSchema,
} from '@bizbot/contracts';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, Lang, RequireModule, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { CatalogService } from './catalog.service';
import { ServicesService } from './services.service';

@Controller('t/:tenantId/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @RequirePermission('product:read', 'service:read')
  listCategories(@Query('includeInactive') includeInactive?: string) {
    return this.catalog.listCategories({ includeInactive: includeInactive === 'true' });
  }

  @Post('categories')
  @RequirePermission('product:write')
  createCategory(@CurrentActor() actor: RequestActor, @Body(zodBody(createCategorySchema)) dto: Record<string, unknown>) {
    return this.catalog.createCategory(actor.userId!, dto);
  }

  @Patch('categories/:id')
  @RequirePermission('product:write')
  updateCategory(@CurrentActor() actor: RequestActor, @Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.catalog.updateCategory(actor.userId!, id, dto);
  }

  @Delete('categories/:id')
  @RequirePermission('product:delete')
  @HttpCode(204)
  deleteCategory(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.catalog.deleteCategory(actor.userId!, id);
  }

  @Get('products')
  @RequireModule('CATALOG')
  @RequirePermission('product:read')
  listProducts(@Query(zodQuery(listProductsSchema)) query: Record<string, unknown>) {
    return this.catalog.listProducts(query);
  }

  @Get('products/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:read')
  getProduct(@Param('id') id: string) {
    return this.catalog.getProduct(id);
  }

  @Post('products')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  createProduct(@CurrentActor() actor: RequestActor, @Body(zodBody(createProductSchema)) dto: Record<string, unknown>) {
    return this.catalog.createProduct(actor.userId!, dto);
  }

  @Patch('products/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  updateProduct(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(updateProductSchema)) dto: Record<string, unknown>,
  ) {
    return this.catalog.updateProduct(actor.userId!, id, dto);
  }

  @Delete('products/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:delete')
  @HttpCode(204)
  archiveProduct(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.catalog.archiveProduct(actor.userId!, id);
  }

  @Post('products/:id/variants')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  createVariant(@Param('id') productId: string, @Body(zodBody(createVariantSchema)) dto: Record<string, unknown>) {
    return this.catalog.createVariant(productId, dto);
  }

  @Patch('variants/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  updateVariant(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.catalog.updateVariant(id, dto);
  }

  @Delete('variants/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  @HttpCode(204)
  deleteVariant(@Param('id') id: string) {
    return this.catalog.deleteVariant(id);
  }

  @Get('modifier-groups')
  @RequireModule('CATALOG')
  @RequirePermission('product:read')
  listModifierGroups() {
    return this.catalog.listModifierGroups();
  }

  @Post('modifier-groups')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  createModifierGroup(@Body(zodBody(createModifierGroupSchema)) dto: never) {
    return this.catalog.createModifierGroup(dto);
  }

  @Patch('modifier-groups/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  updateModifierGroup(@Param('id') id: string, @Body() dto: never) {
    return this.catalog.updateModifierGroup(id, dto);
  }

  @Delete('modifier-groups/:id')
  @RequireModule('CATALOG')
  @RequirePermission('product:write')
  @HttpCode(204)
  deleteModifierGroup(@Param('id') id: string) {
    return this.catalog.deleteModifierGroup(id);
  }
}

@Controller('t/:tenantId/services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  @RequireModule('SERVICES')
  @RequirePermission('service:read')
  list(@Query() query: Record<string, unknown>, @Lang() lang: 'uz' | 'ru' | 'en') {
    return this.services.list(query, lang);
  }

  @Get(':id')
  @RequireModule('SERVICES')
  @RequirePermission('service:read')
  detail(@Param('id') id: string) {
    return this.services.detail(id);
  }

  @Post()
  @RequireModule('SERVICES')
  @RequirePermission('service:write')
  create(@CurrentActor() actor: RequestActor, @Body(zodBody(createServiceSchema)) dto: Record<string, unknown>) {
    return this.services.create(actor.userId!, dto);
  }

  @Patch(':id')
  @RequireModule('SERVICES')
  @RequirePermission('service:write')
  update(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(updateServiceSchema)) dto: Record<string, unknown>,
  ) {
    return this.services.update(actor.userId!, id, dto);
  }

  @Delete(':id')
  @RequireModule('SERVICES')
  @RequirePermission('service:delete')
  @HttpCode(204)
  archive(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.services.archive(actor.userId!, id);
  }
}

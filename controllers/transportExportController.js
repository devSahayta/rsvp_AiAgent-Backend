// controllers/transportExportController.js
// Export pickup plans to PDF and Excel formats

import { supabase } from "../config/supabase.js";
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';

/**
 * Export pickup plan as PDF
 * GET /api/transport/export/pdf/:plan_id
 */
export const exportPlanPDF = async (req, res) => {
  try {
    const { plan_id } = req.params;

    // Fetch plan with all details
    const { data: plan, error: planError } = await supabase
      .from("pickup_plans")
      .select(`
        *,
        pickup_groups (
          *,
          passengers_details
        )
      `)
      .eq("plan_id", plan_id)
      .single();

    if (planError || !plan) {
      return res.status(404).json({
        success: false,
        error: "Plan not found"
      });
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=pickup-plan-${plan_id}.pdf`);
    
    // Pipe PDF to response
    doc.pipe(res);

    // Title
    doc.fontSize(20).font('Helvetica-Bold').text('Transport Pickup Plan', { align: 'center' });
    doc.moveDown();

    // Plan Summary
    doc.fontSize(14).font('Helvetica-Bold').text('Summary');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Date Generated: ${new Date(plan.generated_at).toLocaleString('en-IN')}`);
    doc.text(`Total Vehicles: ${plan.total_vehicles_used}`);
    doc.text(`Total Passengers: ${plan.total_passengers}`);
    doc.text(`Locations: ${plan.total_locations}`);
    // doc.text(`Cost Saved: ₹${plan.cost_saved.toLocaleString('en-IN')}`);
    doc.text(`Avg Wait Time: ${plan.avg_wait_time_minutes} minutes`);
    doc.moveDown(2);

    // Pickup Groups
    plan.pickup_groups.forEach((group, index) => {
      // Add page break if needed
      if (index > 0 && doc.y > 650) {
        doc.addPage();
      }

      // Group Header
      doc.fontSize(12).font('Helvetica-Bold')
        .text(`Vehicle ${group.vehicle_number}: ${group.vehicle_name}`, { underline: true });
      doc.fontSize(10).font('Helvetica');
      doc.text(`Type: ${group.vehicle_type} | Capacity: ${group.vehicle_capacity} seats`);
      doc.text(`Location: ${group.pickup_location}`);
      doc.text(`Passengers: ${group.passenger_count}/${group.vehicle_capacity}`);
      doc.moveDown(0.5);

      // Timeline
      doc.font('Helvetica-Bold').text('Timeline:');
      doc.font('Helvetica');
      doc.text(`  Arrival: ${formatTime(group.vehicle_arrival_time)}`);
      doc.text(`  First Pickup: ${formatTime(group.first_passenger_arrival)}`);
      doc.text(`  Departure: ${formatTime(group.vehicle_departure_time)}`);
      doc.moveDown(0.5);

      // Passenger List
      doc.font('Helvetica-Bold').text('Passengers:');
      doc.font('Helvetica');
      
      group.passengers_details.forEach((passenger, i) => {
        doc.text(`  ${i + 1}. ${passenger.name} - ${passenger.phone}`);
        doc.text(`     Pickup: ${formatTime(passenger.pickup_time)} | Wait: ${passenger.wait_minutes} min`);
      });
      
      doc.moveDown(0.5);

      // Driver Instructions
      doc.font('Helvetica-Bold').text('Driver Instructions:');
      doc.font('Helvetica').fontSize(9).text(group.driver_instructions, {
        width: 500,
        align: 'justify'
      });
      
      doc.fontSize(10).moveDown(1.5);

      // Separator
      if (index < plan.pickup_groups.length - 1) {
        doc.strokeColor('#cccccc').lineWidth(1)
          .moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
      }
    });

    // Footer
    doc.fontSize(8).font('Helvetica').fillColor('#666666')
      .text(`Generated on ${new Date().toLocaleString('en-IN')}`, 50, 750, {
        align: 'center'
      });

    // Finalize PDF
    doc.end();

  } catch (error) {
    console.error("❌ PDF export error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Export pickup plan as Excel
 * GET /api/transport/export/excel/:plan_id
 */
export const exportPlanExcel = async (req, res) => {
  try {
    const { plan_id } = req.params;

    // Fetch plan with all details
    const { data: plan, error: planError } = await supabase
      .from("pickup_plans")
      .select(`
        *,
        pickup_groups (
          *,
          passengers_details
        )
      `)
      .eq("plan_id", plan_id)
      .single();

    if (planError || !plan) {
      return res.status(404).json({
        success: false,
        error: "Plan not found"
      });
    }

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Transport Planning System';
    workbook.created = new Date();

    // Summary Sheet
    const summarySheet = workbook.addWorksheet('Summary');
    
    // Title
    summarySheet.mergeCells('A1:D1');
    summarySheet.getCell('A1').value = 'Transport Pickup Plan - Summary';
    summarySheet.getCell('A1').font = { size: 16, bold: true };
    summarySheet.getCell('A1').alignment = { horizontal: 'center' };

    // Summary Data
    summarySheet.addRow([]);
    summarySheet.addRow(['Generated At:', new Date(plan.generated_at).toLocaleString('en-IN')]);
    summarySheet.addRow(['Total Vehicles Used:', plan.total_vehicles_used]);
    summarySheet.addRow(['Total Passengers:', plan.total_passengers]);
    summarySheet.addRow(['Total Locations:', plan.total_locations]);
    summarySheet.addRow(['Vehicles Saved:', plan.vehicles_saved]);
    // summarySheet.addRow(['Estimated Cost:', `₹${plan.estimated_cost.toLocaleString('en-IN')}`]);
    // summarySheet.addRow(['Cost Saved:', `₹${plan.cost_saved.toLocaleString('en-IN')}`]);
    summarySheet.addRow(['Avg Wait Time:', `${plan.avg_wait_time_minutes} minutes`]);
    summarySheet.addRow(['Max Wait Time:', `${plan.max_wait_time_minutes_actual} minutes`]);

    // Style summary
    summarySheet.getColumn('A').width = 25;
    summarySheet.getColumn('B').width = 30;
    summarySheet.eachRow((row, rowNumber) => {
      if (rowNumber > 2) {
        row.getCell(1).font = { bold: true };
      }
    });

    // Vehicles Sheet
    const vehiclesSheet = workbook.addWorksheet('Vehicles');
    
    // Header row
    vehiclesSheet.columns = [
      { header: 'Vehicle #', key: 'number', width: 12 },
      { header: 'Vehicle Name', key: 'name', width: 20 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Capacity', key: 'capacity', width: 10 },
      { header: 'Location', key: 'location', width: 25 },
      { header: 'Passengers', key: 'passengers', width: 12 },
      { header: 'Utilization', key: 'utilization', width: 12 },
      { header: 'Arrival Time', key: 'arrival', width: 15 },
      { header: 'Departure Time', key: 'departure', width: 15 },
      { header: 'Avg Wait (min)', key: 'avgWait', width: 15 },
      { header: 'Max Wait (min)', key: 'maxWait', width: 15 }
    ];

    // Style header
    vehiclesSheet.getRow(1).font = { bold: true };
    vehiclesSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    vehiclesSheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };

    // Add vehicle data
    plan.pickup_groups.forEach(group => {
      vehiclesSheet.addRow({
        number: group.vehicle_number,
        name: group.vehicle_name,
        type: group.vehicle_type,
        capacity: group.vehicle_capacity,
        location: group.pickup_location,
        passengers: group.passenger_count,
        utilization: `${Math.round((group.passenger_count / group.vehicle_capacity) * 100)}%`,
        arrival: formatTime(group.vehicle_arrival_time),
        departure: formatTime(group.vehicle_departure_time),
        avgWait: group.avg_wait_time_minutes,
        maxWait: group.max_wait_time_minutes
      });
    });

    // Passengers Sheet
    const passengersSheet = workbook.addWorksheet('Passengers');
    
    passengersSheet.columns = [
      { header: 'Vehicle #', key: 'vehicleNum', width: 12 },
      { header: 'Vehicle Name', key: 'vehicleName', width: 20 },
      { header: 'Passenger Name', key: 'name', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Pickup Location', key: 'location', width: 25 },
      { header: 'Pickup Time', key: 'pickupTime', width: 15 },
      { header: 'Wait Time (min)', key: 'waitTime', width: 15 },
      { header: 'Flight/Train', key: 'transport', width: 15 }
    ];

    // Style header
    passengersSheet.getRow(1).font = { bold: true };
    passengersSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF70AD47' }
    };
    passengersSheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };

    // Add passenger data
    plan.pickup_groups.forEach(group => {
      group.passengers_details.forEach(passenger => {
        passengersSheet.addRow({
          vehicleNum: group.vehicle_number,
          vehicleName: group.vehicle_name,
          name: passenger.name,
          phone: passenger.phone,
          location: group.pickup_location,
          pickupTime: formatTime(passenger.pickup_time),
          waitTime: passenger.wait_minutes,
          transport: passenger.transport_number || 'N/A'
        });
      });
    });

    // Driver Instructions Sheet
    const instructionsSheet = workbook.addWorksheet('Driver Instructions');
    
    instructionsSheet.columns = [
      { header: 'Vehicle #', key: 'vehicleNum', width: 12 },
      { header: 'Vehicle Name', key: 'vehicleName', width: 20 },
      { header: 'Instructions', key: 'instructions', width: 80 }
    ];

    // Style header
    instructionsSheet.getRow(1).font = { bold: true };
    instructionsSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFC000' }
    };
    instructionsSheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };

    // Add instructions
    plan.pickup_groups.forEach(group => {
      const row = instructionsSheet.addRow({
        vehicleNum: group.vehicle_number,
        vehicleName: group.vehicle_name,
        instructions: group.driver_instructions
      });
      row.getCell('instructions').alignment = { wrapText: true };
      row.height = 60;
    });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=pickup-plan-${plan_id}.xlsx`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("❌ Excel export error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * Helper: Format time
 */
function formatTime(datetime) {
  return new Date(datetime).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}